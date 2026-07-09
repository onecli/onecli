"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, Loader2, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useAgents } from "@/hooks/use-agents";
import { queryKeys } from "@/lib/api/keys";
import { withProjectPrefix } from "@/lib/navigation";
import { Button } from "@onecli/ui/components/button";
import { Accordion } from "@onecli/ui/components/accordion";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import type {
  AppToolGroupSummary,
  AppPermissionLevel,
  AppPermissionSetting,
} from "@onecli/api/apps/app-permissions";
import { allGroupTools } from "@onecli/api/apps/app-permissions/types";
import type { RuleCondition } from "@onecli/api/validations/policy-rule";
import {
  rules as rulesApi,
  type PageScope,
  type AppPermissionStatesResult,
} from "@/lib/api";
import { AgentScopeSelect } from "@/lib/components/agent-scope-select";
import { ConditionBuilder } from "@/lib/components/condition-builder";
import { isToolFullyLocked as checkToolFullyLocked } from "./resolve-tool-permission";
import { AppPermissionGroup } from "./app-permission-group";

interface AppPermissionsProps {
  provider: string;
  appName: string;
  groups: AppToolGroupSummary[];
  orgStates?: Record<string, AppPermissionLevel>;
  orgConditions?: Record<string, unknown[]>;
  policyMode?: "allow" | "deny";
  pageScope?: PageScope;
}

const EMPTY_LAYERS: AppPermissionStatesResult = { defaults: {}, byAgent: {} };

/** Agent-override chips shown before collapsing into a "+N more" pill. */
const CHIP_LIMIT = 4;

export const AppPermissions = ({
  provider,
  appName,
  groups,
  orgStates,
  orgConditions,
  policyMode = "allow",
  pageScope = "project",
}: AppPermissionsProps) => {
  // The per-agent scope switcher only exists at project scope — org rules are
  // agent-less.
  const agentScoping = pageScope === "project";
  const defaultPermission: AppPermissionLevel =
    policyMode === "deny" ? "block" : "allow";
  const pathname = usePathname();
  const [layers, setLayers] = useState<AppPermissionStatesResult>(EMPTY_LAYERS);
  const [scopeAgentId, setScopeAgentId] = useState("");
  const [allChipsShown, setAllChipsShown] = useState(false);
  const [overlappingRuleCount, setOverlappingRuleCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [conditionDialogOpen, setConditionDialogOpen] = useState(false);
  const [conditionScopeAgentId, setConditionScopeAgentId] = useState("");
  const [editingConditions, setEditingConditions] = useState<RuleCondition[]>(
    [],
  );
  const queryClient = useQueryClient();
  const { data: agentsList = [] } = useAgents(agentScoping);

  // Every optimistic write bumps this; an in-flight background refetch that
  // started earlier is stale and must not clobber the newer optimistic state.
  const layersVersionRef = useRef(0);

  const fetchLayers = useCallback(async () => {
    const version = ++layersVersionRef.current;
    const [s, { count }] = await Promise.all([
      rulesApi.permissionStates(provider, pageScope),
      rulesApi.overlapCount(provider, pageScope),
    ]);
    if (version !== layersVersionRef.current) return;
    setLayers(s);
    setOverlappingRuleCount(count);
  }, [provider, pageScope]);

  useEffect(() => {
    fetchLayers()
      .catch(() => toast.error("Failed to load permission states"))
      .finally(() => setLoading(false));
  }, [fetchLayers]);

  const agents = useMemo(
    () => agentsList.map((a) => ({ id: a.id, name: a.name })),
    [agentsList],
  );
  // Self-heals when the selected agent is deleted: falls back to All agents.
  const activeAgentId = agents.some((a) => a.id === scopeAgentId)
    ? scopeAgentId
    : "";
  const activeAgent = agents.find((a) => a.id === activeAgentId);
  const baseStates = layers.defaults;
  const agentStates = useMemo(
    () => (activeAgentId ? (layers.byAgent[activeAgentId] ?? {}) : {}),
    [activeAgentId, layers.byAgent],
  );
  const activeLayerStates = activeAgentId ? agentStates : baseStates;

  const overrideCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const agent of agents) {
      const n = Object.keys(layers.byAgent[agent.id] ?? {}).length;
      if (n > 0) counts[agent.id] = n;
    }
    return counts;
  }, [agents, layers.byAgent]);
  const agentsWithOverrides = agents.filter(
    (a) => (overrideCounts[a.id] ?? 0) > 0,
  );

  const applyChanges = useCallback(
    async (
      changes: { toolId: string; permission: AppPermissionSetting }[],
      conditions?: RuleCondition[],
    ): Promise<boolean> => {
      let prev: AppPermissionStatesResult = EMPTY_LAYERS;
      setLayers((current) => {
        prev = current;
        if (!activeAgentId) {
          const defaults = { ...current.defaults };
          for (const c of changes) {
            if (c.permission === "inherit") continue; // base layer never inherits
            defaults[c.toolId] = {
              permission: c.permission,
              conditions:
                conditions ?? current.defaults[c.toolId]?.conditions ?? [],
            };
          }
          return { ...current, defaults };
        }
        const layer = { ...(current.byAgent[activeAgentId] ?? {}) };
        for (const c of changes) {
          if (c.permission === "inherit") {
            delete layer[c.toolId];
          } else {
            layer[c.toolId] = {
              permission: c.permission,
              conditions: conditions ?? layer[c.toolId]?.conditions ?? [],
            };
          }
        }
        return {
          ...current,
          byAgent: { ...current.byAgent, [activeAgentId]: layer },
        };
      });

      setSaving(true);
      try {
        await rulesApi.setPermissions(
          provider,
          { changes, conditions, agentId: activeAgentId || undefined },
          pageScope,
        );
        queryClient.invalidateQueries({ queryKey: queryKeys.rules.all() });
        queryClient.invalidateQueries({ queryKey: queryKeys.counts.all() });
        // Server-side reconciliation can reshape rows beyond the optimistic
        // update (wildcard expansion). Awaiting keeps `saving` true through
        // the re-sync, so no other write can interleave with it.
        await fetchLayers().catch(() => {});
        return true;
      } catch {
        setLayers(prev);
        toast.error("Failed to update permissions");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [provider, pageScope, activeAgentId, queryClient, fetchLayers],
  );

  const handlePermissionChange = useCallback(
    (toolId: string, permission: AppPermissionLevel) => {
      applyChanges([{ toolId, permission }]);
    },
    [applyChanges],
  );

  const handleRevert = useCallback(
    (toolIds: string[]) => {
      void applyChanges(
        toolIds.map((toolId) => ({ toolId, permission: "inherit" as const })),
      );
    },
    [applyChanges],
  );

  const handleGroupChange = useCallback(
    (group: AppToolGroupSummary, permission: AppPermissionLevel) => {
      const changes = group.tools.map((t) => ({
        toolId: t.id,
        permission,
      }));

      if (activeAgentId) {
        // Agent layers hold no wildcard rows — a group change is per-tool.
        applyChanges(changes);
        return;
      }

      const { wildcard } = group;
      const wildcardActive =
        wildcard != null &&
        baseStates[wildcard.id]?.permission != null &&
        baseStates[wildcard.id]?.permission !== defaultPermission;

      if (wildcardActive && wildcard) {
        changes.push({ toolId: wildcard.id, permission: defaultPermission });

        let prev: AppPermissionStatesResult = EMPTY_LAYERS;
        setLayers((current) => {
          prev = current;
          const defaults = { ...current.defaults };
          for (const t of group.tools) {
            defaults[t.id] = { permission, conditions: [] };
          }
          delete defaults[wildcard.id];
          return { ...current, defaults };
        });

        setSaving(true);
        rulesApi
          .setPermissions(provider, { changes }, pageScope)
          .then(() => {
            queryClient.invalidateQueries({ queryKey: queryKeys.rules.all() });
            queryClient.invalidateQueries({ queryKey: queryKeys.counts.all() });
            return fetchLayers().catch(() => {});
          })
          .catch(() => {
            setLayers(prev);
            toast.error("Failed to update permissions");
          })
          .finally(() => setSaving(false));
      } else {
        applyChanges(changes);
      }
    },
    [
      applyChanges,
      activeAgentId,
      baseStates,
      defaultPermission,
      provider,
      pageScope,
      queryClient,
      fetchLayers,
    ],
  );

  const expandWildcard = useCallback(
    (
      group: AppToolGroupSummary,
      overrideToolId?: string,
      overridePermission?: AppPermissionLevel,
    ) => {
      const { wildcard } = group;
      if (!wildcard) return;

      const changes: { toolId: string; permission: AppPermissionLevel }[] = [];
      let prev: AppPermissionStatesResult = EMPTY_LAYERS;

      setLayers((current) => {
        const wildcardPerm = current.defaults[wildcard.id]?.permission;
        if (!wildcardPerm) return current;

        prev = current;
        const defaults = { ...current.defaults };
        for (const t of group.tools) {
          const perm =
            t.id === overrideToolId && overridePermission
              ? overridePermission
              : wildcardPerm;
          defaults[t.id] = { permission: perm, conditions: [] };
          changes.push({ toolId: t.id, permission: perm });
        }
        delete defaults[wildcard.id];
        changes.push({ toolId: wildcard.id, permission: defaultPermission });
        return { ...current, defaults };
      });

      if (changes.length === 0) return;

      setSaving(true);
      rulesApi
        .setPermissions(provider, { changes }, pageScope)
        .then(() => {
          queryClient.invalidateQueries({ queryKey: queryKeys.rules.all() });
          queryClient.invalidateQueries({ queryKey: queryKeys.counts.all() });
          return fetchLayers().catch(() => {});
        })
        .catch(() => {
          setLayers(prev);
          toast.error("Failed to update permission");
        })
        .finally(() => setSaving(false));
    },
    [provider, pageScope, defaultPermission, queryClient, fetchLayers],
  );

  const openConditionDialog = () => {
    const firstCondition = Object.values(activeLayerStates).find(
      (s) => s.conditions.length > 0,
    );
    setEditingConditions((firstCondition?.conditions as RuleCondition[]) ?? []);
    setConditionScopeAgentId(activeAgentId);
    setConditionDialogOpen(true);
  };

  const isLocked = (toolId: string) =>
    checkToolFullyLocked(
      orgStates?.[toolId],
      (orgConditions?.[toolId] ?? []) as RuleCondition[],
    );

  // Tools the condition dialog targets: the active agent's overrides, or the
  // base layer's restricted (non-default) tools.
  const conditionTargetTools = groups.flatMap(allGroupTools).filter((t) => {
    if (isLocked(t.id)) return false;
    if (activeAgentId) return agentStates[t.id] != null;
    return (
      (baseStates[t.id]?.permission ?? defaultPermission) !== defaultPermission
    );
  });

  const handleSaveConditions = async () => {
    // The scope may have changed while the dialog was open (e.g. the selected
    // agent was deleted and the view self-healed) — never retarget the edit.
    if (conditionScopeAgentId !== activeAgentId) {
      setConditionDialogOpen(false);
      return;
    }
    if (conditionTargetTools.length === 0) {
      setConditionDialogOpen(false);
      return;
    }

    const changes = conditionTargetTools.map((t) => ({
      toolId: t.id,
      permission:
        activeLayerStates[t.id]?.permission ?? ("block" as AppPermissionLevel),
    }));

    const ok = await applyChanges(changes, editingConditions);
    if (!ok) return;
    setConditionDialogOpen(false);
    toast.success(
      activeAgentId
        ? "Conditions updated for all overridden tools"
        : "Conditions updated for all restricted tools",
    );
  };

  const hasAnyConditions = Object.values(activeLayerStates).some(
    (s) => s.conditions.length > 0,
  );
  const conditionTargetCount = conditionTargetTools.length;

  if (loading) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Permissions</h3>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const rulesHref = withProjectPrefix(pathname, "/rules");
  const showScopeSelect = agentScoping && agents.length > 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Permissions</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {activeAgent
              ? `Control what ${activeAgent.name} can do with ${appName}. Overrides apply to this agent only.`
              : `Control what agents can do with ${appName}. Applied to all connected accounts.`}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {conditionTargetCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground gap-1.5"
              onClick={openConditionDialog}
            >
              <Settings2 className="size-3.5" />
              {hasAnyConditions ? "Edit condition" : "Add condition"}
            </Button>
          )}
          {showScopeSelect && (
            <AgentScopeSelect
              agents={agents}
              value={activeAgentId}
              onChange={setScopeAgentId}
              overrideCounts={overrideCounts}
              disabled={saving}
              triggerClassName="h-7 w-auto gap-1.5 bg-card px-2.5 text-xs"
              ariaLabel="Agent scope"
            />
          )}
        </div>
      </div>
      {!activeAgentId && agentsWithOverrides.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">
            Agent overrides:
          </span>
          {(allChipsShown
            ? agentsWithOverrides
            : agentsWithOverrides.slice(0, CHIP_LIMIT)
          ).map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setScopeAgentId(a.id)}
              className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
            >
              {a.name}{" "}
              <span className="text-muted-foreground/60">
                · {overrideCounts[a.id]}
              </span>
            </button>
          ))}
          {agentsWithOverrides.length > CHIP_LIMIT && (
            <button
              type="button"
              aria-expanded={allChipsShown}
              onClick={() => setAllChipsShown((shown) => !shown)}
              className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
            >
              {allChipsShown
                ? "Show less"
                : `+${agentsWithOverrides.length - CHIP_LIMIT} more`}
            </button>
          )}
        </div>
      )}
      {overlappingRuleCount > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
          <AlertTriangle className="size-3.5 text-amber-500 shrink-0" />
          <p className="text-xs text-muted-foreground">
            Some endpoints are also restricted by{" "}
            <Link
              href={rulesHref}
              className="text-foreground underline underline-offset-2"
            >
              {overlappingRuleCount}{" "}
              {overlappingRuleCount === 1 ? "rule" : "rules"}
            </Link>{" "}
            on the Rules page.
          </p>
        </div>
      )}
      <Accordion type="multiple" defaultValue={groups.map((g) => g.category)}>
        {groups.map((group) => (
          <AppPermissionGroup
            key={group.category}
            group={group}
            permissionStates={activeLayerStates}
            agentView={!!activeAgentId}
            baseStates={activeAgentId ? baseStates : undefined}
            onPermissionChange={handlePermissionChange}
            onGroupChange={(perm) => handleGroupChange(group, perm)}
            onGroupInherit={() => handleRevert(group.tools.map((t) => t.id))}
            onToolRevert={(toolId) => handleRevert([toolId])}
            onWildcardReset={
              activeAgentId ? undefined : () => expandWildcard(group)
            }
            onCoveredPermissionChange={
              activeAgentId
                ? undefined
                : (toolId, perm) => expandWildcard(group, toolId, perm)
            }
            disabled={saving}
            orgStates={orgStates}
            orgConditions={orgConditions}
            defaultPermission={defaultPermission}
          />
        ))}
      </Accordion>

      <Dialog open={conditionDialogOpen} onOpenChange={setConditionDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit condition</DialogTitle>
            <DialogDescription>
              {activeAgent
                ? `This condition applies to all ${conditionTargetCount} overridden ${
                    conditionTargetCount === 1 ? "tool" : "tools"
                  } for ${activeAgent.name}.`
                : `This condition applies to all ${conditionTargetCount} restricted ${
                    conditionTargetCount === 1 ? "tool" : "tools"
                  } for ${appName}.`}
            </DialogDescription>
          </DialogHeader>
          <ConditionBuilder
            conditions={editingConditions}
            onChange={setEditingConditions}
          />
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConditionDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button onClick={handleSaveConditions} loading={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
