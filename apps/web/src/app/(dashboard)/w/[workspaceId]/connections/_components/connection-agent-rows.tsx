"use client";

import { useState } from "react";
import { ChevronDown, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { useMutationState } from "@tanstack/react-query";
import { Button } from "@onecli/ui/components/button";
import { Switch } from "@onecli/ui/components/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { cn } from "@onecli/ui/lib/utils";
import type { ConnectionGrantInput, ConnectionGrants } from "@/lib/api";
import {
  useConnectionEffectiveAgents,
  type EffectiveAgentEntry,
} from "@/lib/api/policy-visibility";
import { agentConnectionState } from "@/lib/components/policy-reflect/agent-connection-state";
import {
  GRANTS_FAMILY,
  grantTarget,
  grantToastId,
  useConnectionGrants,
  useDetachConnectionForAgent,
  useSetConnectionGrantForAgent,
} from "@/hooks/use-grants";
import { optimisticKey } from "@/hooks/use-optimistic-mutation";
import { usePinnedPlacement } from "@/hooks/use-stable-placement";
import { ManageAgentPermissions } from "./manage-agent-permissions";
import type { AccountCardConnection } from "./account-card-connection";

/** Rows shown before "Show N more" expands the rest in place. */
const VISIBLE_ROWS = 2;

type Grant = ConnectionGrants["agents"][number];

/** The write that puts a removed grant back exactly as it was: its tools,
 * catch-alls and resource scope (`resources: null` clears, so an unscoped
 * grant comes back unscoped). */
const restoreInput = (grant: Grant): ConnectionGrantInput =>
  grant.access === "custom"
    ? {
        access: "custom",
        allow: grant.allow,
        ask: grant.ask,
        otherReads: grant.otherReads,
        otherWrites: grant.otherWrites,
        resources: grant.resources,
      }
    : { access: "full", resources: grant.resources };

const accessLabel = (grant: Grant | undefined) => {
  if (!grant || grant.access === "full") return "Full access";
  const tools = grant.allow.length + grant.ask.length;
  return `Custom · ${tools} ${tools === 1 ? "tool" : "tools"}`;
};

export interface ConnectionAgentRowsProps {
  connection: AccountCardConnection;
}

/**
 * The account card's agent panel: every agent of the workspace on one line,
 * with a switch to turn this account on/off for it (applies at once, with
 * Undo), what it may do, and a gear straight into that agent's permissions
 * for this one account. Reads the enforced rules (the effective view) beside
 * the workspace grants, like the Agent access dialog, so an agent the org
 * grants shows as on and locked, and one the org blocks says so.
 *
 * Switches move on click (the grants hooks are optimistic). While an agent's
 * write is settling, its row reads the grant alone: the effective view still
 * describes the state before the click, so its "blocked" verdict is held
 * back rather than shown beside a switch that already says otherwise.
 */
export const ConnectionAgentRows = ({
  connection,
}: ConnectionAgentRowsProps) => {
  const effectiveQuery = useConnectionEffectiveAgents(connection.id);
  const grantsQuery = useConnectionGrants(connection.id);
  const attach = useSetConnectionGrantForAgent();
  const detach = useDetachConnectionForAgent();
  const [managing, setManaging] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Agents of THIS connection with a grant write still settling.
  const settlingAgents = new Set(
    useMutationState({
      filters: {
        mutationKey: optimisticKey(GRANTS_FAMILY),
        status: "pending",
        predicate: (m) =>
          grantTarget(m.state.variables)?.connectionId === connection.id,
      },
      select: (m) => grantTarget(m.state.variables)?.agentId ?? null,
    }).filter((id): id is string => id !== null),
  );
  const grantByAgent = new Map(
    (grantsQuery.data?.agents ?? []).map((g) => [g.agentId, g]),
  );
  const stateOf = (agent: EffectiveAgentEntry) => {
    const state = agentConnectionState(agent, grantByAgent.has(agent.agentId));
    return settlingAgents.has(agent.agentId)
      ? { ...state, blocked: false }
      : state;
  };
  // "On first" ordering, except a row the user just toggled keeps its slot
  // until the next visit, so it never jumps out from under the pointer.
  const effectiveById = new Map(
    (effectiveQuery.data?.agents ?? []).map((a) => [a.agentId, a]),
  );
  const placement = usePinnedPlacement((agentId: string) => {
    const agent = effectiveById.get(agentId);
    return agent ? stateOf(agent).on : false;
  });

  // Switches never render over unknown grant state: both views first.
  if (effectiveQuery.isPending || grantsQuery.isPending) {
    return (
      <div className="space-y-1.5 border-t pt-2.5">
        {[0, 1].map((i) => (
          <div key={i} className="bg-muted h-6 animate-pulse rounded" />
        ))}
      </div>
    );
  }
  if (effectiveQuery.isError || grantsQuery.isError) {
    return (
      <p role="alert" className="text-destructive border-t pt-2.5 text-xs">
        Couldn&apos;t load agent access for this account.
      </p>
    );
  }

  const agents = effectiveQuery.data.agents;
  if (agents.length === 0) {
    return (
      <p className="text-muted-foreground border-t pt-2.5 text-xs">
        No agents in this workspace yet.
      </p>
    );
  }

  const rows = agents.map((agent) => ({
    agent,
    grant: grantByAgent.get(agent.agentId),
    state: stateOf(agent),
  }));
  const onCount = rows.filter((r) => r.state.on).length;
  // On first, so the agents that matter are the ones always visible.
  const sorted = [...rows].sort(
    (a, b) =>
      Number(placement.placeOf(b.agent.agentId)) -
        Number(placement.placeOf(a.agent.agentId)) ||
      a.agent.name.localeCompare(b.agent.name),
  );
  const visible = expanded ? sorted : sorted.slice(0, VISIBLE_ROWS);
  const hidden = sorted.length - Math.min(sorted.length, VISIBLE_ROWS);
  const accountName = connection.label ?? connection.provider;

  const toggle = (agentId: string, agentName: string, next: boolean) => {
    placement.pin(agentId);
    if (next) {
      // The product default every attach toggle writes: reads allowed,
      // writes and anything else need approval. The toast is the door to
      // narrow it, so it shows at once, with the switch.
      attach.mutate({
        connectionId: connection.id,
        agentId,
        input: { access: "default" },
      });
      toast.success(`${agentName} can use ${accountName}`, {
        id: grantToastId(agentId, connection.id),
        action: {
          label: "Permissions",
          onClick: () => setManaging(agentId),
        },
      });
      return;
    }
    const previous = grantByAgent.get(agentId);
    detach.mutate({ connectionId: connection.id, agentId });
    // Undo is offered at once: it queues behind the detach (writes to one
    // agent × account run in order), so it can be pressed before the server
    // has even answered. A failed detach replaces this with its error.
    toast(`${agentName} can no longer use ${accountName}`, {
      id: grantToastId(agentId, connection.id),
      action: previous
        ? {
            label: "Undo",
            onClick: () =>
              attach.mutate({
                connectionId: connection.id,
                agentId,
                input: restoreInput(previous),
              }),
          }
        : undefined,
    });
  };

  return (
    <div className="space-y-1 border-t pt-2.5">
      <div className="text-muted-foreground flex items-center justify-between text-[11px] font-medium tracking-wide uppercase">
        <span>Agents</span>
        <span className="normal-case tracking-normal">
          {onCount === rows.length
            ? "All on"
            : `${onCount} of ${rows.length} on`}
        </span>
      </div>
      {visible.map(({ agent, grant, state }) => {
        const { on, orgGranted, blocked } = state;
        // A blocked agent can still be turned off (that only removes intent),
        // but its permissions can't widen anything, so the gear stays hidden.
        const manageable = on && !blocked;
        const status = blocked
          ? "Blocked by your organization"
          : orgGranted
            ? "Granted by your organization"
            : on
              ? accessLabel(grant)
              : "Off";
        return (
          <div
            key={agent.agentId}
            className="flex min-w-0 items-center gap-2 rounded-md py-0.5"
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                blocked
                  ? "bg-destructive"
                  : on
                    ? "bg-brand"
                    : "bg-muted-foreground/30",
              )}
              aria-hidden="true"
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-xs font-medium",
                !on && "text-muted-foreground",
              )}
            >
              {agent.name}
            </span>
            {manageable ? (
              <button
                type="button"
                onClick={() => setManaging(agent.agentId)}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring shrink-0 rounded-sm text-[11px] underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-none"
              >
                {status}
              </button>
            ) : (
              <span
                className={cn(
                  "shrink-0 text-[11px]",
                  blocked ? "text-destructive" : "text-muted-foreground/70",
                )}
              >
                {status}
              </span>
            )}
            <Switch
              size="sm"
              checked={on}
              // Locked only by the org, never by an in-flight write.
              disabled={orgGranted}
              onCheckedChange={(next) =>
                toggle(agent.agentId, agent.name, next)
              }
              aria-label={`${on ? "Turn off" : "Turn on"} ${accountName} for ${agent.name}`}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "text-muted-foreground size-6 shrink-0",
                    !manageable && "invisible",
                  )}
                  onClick={() => setManaging(agent.agentId)}
                  aria-label={`Permissions for ${agent.name}`}
                  tabIndex={manageable ? 0 : -1}
                >
                  <Settings2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Permissions</TooltipContent>
            </Tooltip>
          </div>
        );
      })}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex items-center gap-1 rounded-sm text-[11px] hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >
          <ChevronDown
            className={cn(
              "size-3 transition-transform",
              expanded && "rotate-180",
            )}
            aria-hidden="true"
          />
          {expanded ? "Show less" : `Show ${hidden} more`}
        </button>
      )}

      {managing && (
        <ManageAgentPermissions
          agentId={managing}
          connection={connection}
          onClose={() => setManaging(null)}
        />
      )}
    </div>
  );
};
