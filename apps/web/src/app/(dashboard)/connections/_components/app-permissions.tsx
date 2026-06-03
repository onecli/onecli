"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, Loader2, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { useInvalidateGatewayCache } from "@/hooks/use-invalidate-cache";
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
  AppToolGroup,
  AppPermissionLevel,
} from "@onecli/api/apps/app-permissions";
import { allGroupTools } from "@onecli/api/apps/app-permissions";
import type { RuleCondition } from "@onecli/api/validations/policy-rule";
import {
  getAppPermissionStates,
  setAppPermissions,
  getOverlappingRuleCountForApp,
  type AppPermissionState,
} from "@/lib/actions/rules";
import { ConditionBuilder } from "@/lib/components/condition-builder";
import { isToolFullyLocked as checkToolFullyLocked } from "./resolve-tool-permission";
import { AppPermissionGroup } from "./app-permission-group";

interface AppPermissionActions {
  getStates: (provider: string) => Promise<Record<string, AppPermissionState>>;
  setPermissions: (
    provider: string,
    changes: { toolId: string; permission: AppPermissionLevel }[],
    conditions?: RuleCondition[],
  ) => Promise<void>;
  getOverlappingRuleCount: (provider: string) => Promise<number>;
}

interface AppPermissionsProps {
  provider: string;
  appName: string;
  groups: AppToolGroup[];
  actions?: AppPermissionActions;
  orgStates?: Record<string, AppPermissionLevel>;
  orgConditions?: Record<string, unknown[]>;
  policyMode?: "allow" | "deny";
}

export const AppPermissions = ({
  provider,
  appName,
  groups,
  actions,
  orgStates,
  orgConditions,
  policyMode = "allow",
}: AppPermissionsProps) => {
  const defaultPermission: AppPermissionLevel =
    policyMode === "deny" ? "block" : "allow";
  const pathname = usePathname();
  const [states, setStates] = useState<Record<string, AppPermissionState>>({});
  const [overlappingRuleCount, setOverlappingRuleCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [conditionDialogOpen, setConditionDialogOpen] = useState(false);
  const [editingConditions, setEditingConditions] = useState<RuleCondition[]>(
    [],
  );
  const invalidateCache = useInvalidateGatewayCache();

  const fetchStates = actions?.getStates ?? getAppPermissionStates;
  const fetchOverlappingCount =
    actions?.getOverlappingRuleCount ?? getOverlappingRuleCountForApp;
  const applyPermissions = actions?.setPermissions ?? setAppPermissions;

  useEffect(() => {
    Promise.all([fetchStates(provider), fetchOverlappingCount(provider)])
      .then(([s, count]) => {
        setStates(s);
        setOverlappingRuleCount(count);
      })
      .catch(() => toast.error("Failed to load permission states"))
      .finally(() => setLoading(false));
  }, [provider, fetchStates, fetchOverlappingCount]);

  const applyChanges = useCallback(
    async (
      changes: { toolId: string; permission: AppPermissionLevel }[],
      conditions?: RuleCondition[],
    ): Promise<boolean> => {
      let prev: Record<string, AppPermissionState> = {};
      setStates((current) => {
        prev = current;
        const next = { ...current };
        for (const c of changes) {
          next[c.toolId] = {
            permission: c.permission,
            conditions: conditions ?? current[c.toolId]?.conditions ?? [],
          };
        }
        return next;
      });

      setSaving(true);
      try {
        await applyPermissions(provider, changes, conditions);
        invalidateCache();
        return true;
      } catch {
        setStates(prev);
        toast.error("Failed to update permissions");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [provider, invalidateCache, applyPermissions],
  );

  const handlePermissionChange = useCallback(
    (toolId: string, permission: AppPermissionLevel) => {
      applyChanges([{ toolId, permission }]);
    },
    [applyChanges],
  );

  const handleGroupChange = useCallback(
    (group: AppToolGroup, permission: AppPermissionLevel) => {
      const { wildcard } = group;
      const wildcardActive =
        wildcard != null &&
        states[wildcard.id]?.permission != null &&
        states[wildcard.id]?.permission !== defaultPermission;

      const changes = group.tools.map((t) => ({
        toolId: t.id,
        permission,
      }));

      if (wildcardActive && wildcard) {
        changes.push({ toolId: wildcard.id, permission: defaultPermission });

        let prev: Record<string, AppPermissionState> = {};
        setStates((current) => {
          prev = current;
          const next = { ...current };
          for (const t of group.tools) {
            next[t.id] = { permission, conditions: [] };
          }
          delete next[wildcard.id];
          return next;
        });

        setSaving(true);
        applyPermissions(provider, changes)
          .then(() => invalidateCache())
          .catch(() => {
            setStates(prev);
            toast.error("Failed to update permissions");
          })
          .finally(() => setSaving(false));
      } else {
        applyChanges(changes);
      }
    },
    [
      applyChanges,
      states,
      defaultPermission,
      provider,
      invalidateCache,
      applyPermissions,
    ],
  );

  const expandWildcard = useCallback(
    (
      group: AppToolGroup,
      overrideToolId?: string,
      overridePermission?: AppPermissionLevel,
    ) => {
      const { wildcard } = group;
      if (!wildcard) return;

      const changes: { toolId: string; permission: AppPermissionLevel }[] = [];
      let prev: Record<string, AppPermissionState> = {};

      setStates((current) => {
        const wildcardPerm = current[wildcard.id]?.permission;
        if (!wildcardPerm) return current;

        prev = current;
        const next = { ...current };
        for (const t of group.tools) {
          const perm =
            t.id === overrideToolId && overridePermission
              ? overridePermission
              : wildcardPerm;
          next[t.id] = { permission: perm, conditions: [] };
          changes.push({ toolId: t.id, permission: perm });
        }
        delete next[wildcard.id];
        changes.push({ toolId: wildcard.id, permission: defaultPermission });
        return next;
      });

      if (changes.length === 0) return;

      setSaving(true);
      applyPermissions(provider, changes)
        .then(() => invalidateCache())
        .catch(() => {
          setStates(prev);
          toast.error("Failed to update permission");
        })
        .finally(() => setSaving(false));
    },
    [provider, invalidateCache, applyPermissions, defaultPermission],
  );

  const openConditionDialog = () => {
    const firstCondition = Object.values(states).find(
      (s) => s.conditions.length > 0,
    );
    setEditingConditions((firstCondition?.conditions as RuleCondition[]) ?? []);
    setConditionDialogOpen(true);
  };

  const isLocked = (toolId: string) =>
    checkToolFullyLocked(
      orgStates?.[toolId],
      (orgConditions?.[toolId] ?? []) as RuleCondition[],
    );

  const handleSaveConditions = async () => {
    const allTools = groups.flatMap(allGroupTools);
    const restrictedTools = allTools.filter((t) => {
      if (isLocked(t.id)) return false;
      const perm = states[t.id]?.permission ?? defaultPermission;
      return perm !== defaultPermission;
    });

    if (restrictedTools.length === 0) {
      setConditionDialogOpen(false);
      return;
    }

    const changes = restrictedTools.map((t) => ({
      toolId: t.id,
      permission: states[t.id]?.permission ?? ("block" as AppPermissionLevel),
    }));

    const ok = await applyChanges(changes, editingConditions);
    if (!ok) return;
    setConditionDialogOpen(false);
    toast.success("Conditions updated for all restricted tools");
  };

  const hasAnyConditions = Object.values(states).some(
    (s) => s.conditions.length > 0,
  );
  const restrictedCount = groups.flatMap(allGroupTools).filter((t) => {
    if (isLocked(t.id)) return false;
    return (
      (states[t.id]?.permission ?? defaultPermission) !== defaultPermission
    );
  }).length;

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

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">Permissions</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Control what agents can do with {appName}. Applied to all connected
            accounts.
          </p>
        </div>
        {restrictedCount > 0 && (
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
      </div>
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
            permissionStates={states}
            onPermissionChange={handlePermissionChange}
            onGroupChange={(perm) => handleGroupChange(group, perm)}
            onWildcardReset={() => expandWildcard(group)}
            onCoveredPermissionChange={(toolId, perm) =>
              expandWildcard(group, toolId, perm)
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
              This condition applies to all {restrictedCount} restricted{" "}
              {restrictedCount === 1 ? "tool" : "tools"} for {appName}.
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
