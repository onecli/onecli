"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Ban, CircleCheck, CircleMinus, Hand, Settings2 } from "lucide-react";
import { AgentIcon } from "@/lib/agents/agent-icon";
import { Button } from "@onecli/ui/components/button";
import { Switch } from "@onecli/ui/components/switch";
import { cn } from "@onecli/ui/lib/utils";
import type {
  AgentAccessStatus,
  EffectiveAgentEntry,
} from "@/lib/api/policy-visibility";
import {
  useDetachConnectionForAgent,
  useSetConnectionGrantForAgent,
} from "@/hooks/use-grants";
import { agentSectionPath } from "@/lib/navigation";

// One agent row of the connection "Agent access" dialog — the step-4 editable
// version, mirroring the agent page's row-state machine: workspace-granted
// (detachable), org-granted (locked on), unattached (attachable).
//
// The row carries AT MOST ONE status element, and only when it says something
// the switch cannot. The switch already means attached/not attached, so a
// "Can use" pill beside an on switch (or "No access" beside an off one) is the
// same fact twice — and four such elements is what pushed this row out of the
// dialog. What survives is the genuinely additional: a block, a narrowed tool
// count, an approval gate, or a catalog-less app.

const ACCESS_META = {
  usable: {
    label: "Can use",
    icon: CircleCheck,
    className:
      "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400",
  },
  limited: {
    label: "Limited",
    icon: CircleMinus,
    className:
      "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  },
  blocked: {
    label: "Blocked",
    icon: Ban,
    className: "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  },
  none: {
    label: "No access",
    className: "bg-muted text-muted-foreground",
  },
  unknown: {
    // Attached, but a custom app with no catalog — access is via network rules.
    label: "Network only",
    className: "bg-muted text-muted-foreground",
  },
} as const satisfies Record<
  AgentAccessStatus,
  { label: string; className: string; icon?: typeof CircleCheck }
>;

const AccessPill = ({ access }: { access: AgentAccessStatus }) => {
  const meta = ACCESS_META[access];
  const Icon = "icon" in meta ? meta.icon : undefined;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        meta.className,
      )}
    >
      {Icon && <Icon className="size-3.5" aria-hidden="true" />}
      {meta.label}
    </span>
  );
};

/**
 * The secondary line under the agent name — only for provenance the switch
 * cannot express. An ordinary workspace grant says nothing: since the attach
 * model every attached agent has a compiled rule literally named
 * "Grant: <agent> · <account>", so naming it here was both pure noise and a
 * leak of an internal identifier into the product.
 */
const attachDetail = (orgGranted: boolean): string | null =>
  orgGranted ? "Via organization" : null;

interface ConnectionAgentAccessRowProps {
  connectionId: string;
  agent: EffectiveAgentEntry;
  /** agentId ∈ the connection's workspace grants (the grants API view). */
  workspaceGranted: boolean;
}

export const ConnectionAgentAccessRow = ({
  connectionId,
  agent,
  workspaceGranted,
}: ConnectionAgentAccessRowProps) => {
  const pathname = usePathname();
  const attach = useSetConnectionGrantForAgent();
  const detach = useDetachConnectionForAgent();
  const busy = attach.isPending || detach.isPending;

  // Injected by an ORG rule (not a workspace grant): locked on — not detachable
  // at workspace level.
  const orgGranted =
    !workspaceGranted &&
    agent.credential.status === "viaRule" &&
    agent.credential.provenance.some((p) => p.scope === "organization");

  const detail = attachDetail(orgGranted);

  // The ONE status element, first match wins. Order is the information
  // hierarchy: a block outranks a count, a count outranks an approval note,
  // and an ordinary working attachment says nothing at all (the switch does).
  const decisions = agent.credential.status !== "none" ? agent.decisions : null;
  const narrowed =
    decisions !== null && decisions.allowedTools < decisions.totalTools;
  const status: "pill" | "count" | "approval" | null =
    agent.access === "blocked" || agent.access === "unknown"
      ? "pill"
      : narrowed
        ? "count"
        : decisions?.anyApproval
          ? "approval"
          : null;

  const manageHref = `${agentSectionPath(pathname, agent.agentId, "connections")}?connection=${encodeURIComponent(connectionId)}&manage=1`;

  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="bg-muted flex size-6 shrink-0 items-center justify-center rounded-md">
          <AgentIcon
            className="text-muted-foreground size-3.5"
            aria-hidden="true"
          />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm">{agent.name}</span>
          {detail && (
            <span className="text-muted-foreground block truncate text-[11px]">
              {detail}
            </span>
          )}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {status === "pill" && <AccessPill access={agent.access} />}
        {status === "count" && (
          <span className="text-muted-foreground inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] tabular-nums">
            {decisions?.allowedTools} of {decisions?.totalTools}
            {decisions?.anyApproval && (
              <>
                <Hand className="size-3" aria-hidden="true" />
                <span className="sr-only">, some need approval</span>
              </>
            )}
            <span className="sr-only"> tools allowed</span>
          </span>
        )}
        {status === "approval" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-blue-50 px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-blue-700 dark:bg-blue-950/50 dark:text-blue-400">
            <Hand className="size-3.5" aria-hidden="true" />
            Needs approval
          </span>
        )}
        {/* Below `sm` the dialog is only viewport-2rem wide, and this row's
            controls do not shrink — so the label collapses to its icon rather
            than widening the dialog's grid column and pushing the switch out
            of reach. The accessible name survives on the link either way. */}
        <Button variant="ghost" size="xs" asChild>
          <Link href={manageHref} aria-label={`Manage ${agent.name}'s access`}>
            <Settings2 className="size-3.5" />
            <span className="hidden sm:inline">Manage</span>
          </Link>
        </Button>
        <Switch
          size="sm"
          checked={workspaceGranted || orgGranted}
          disabled={busy || orgGranted}
          aria-label={`${workspaceGranted || orgGranted ? "Detach" : "Attach"} ${agent.name}`}
          onCheckedChange={(next) => {
            if (next) {
              attach.mutate({
                connectionId,
                agentId: agent.agentId,
                input: { access: "full" },
              });
            } else {
              detach.mutate({ connectionId, agentId: agent.agentId });
            }
          }}
        />
      </span>
    </div>
  );
};
