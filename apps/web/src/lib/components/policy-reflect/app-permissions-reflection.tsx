"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Ban,
  ChevronRight,
  CircleCheck,
  Gauge,
  Hand,
  Info,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@onecli/ui/components/accordion";
import { cn } from "@onecli/ui/lib/utils";
import type {
  EffectiveProvenance,
  EffectiveToolResult,
  EffectiveToolVerdict,
} from "@/lib/api/policy-visibility";
import { withOrgPrefix, withProjectPrefix } from "@/lib/navigation";
import { useAgents } from "@/hooks/use-agents";
import { useAppPermissionDefinitions } from "@/hooks/use-app-permissions";
import { useEffectiveAppPermissions } from "@/lib/api/policy-visibility";
import { AgentScopeSelect } from "@/lib/components/agent-scope-select";
import type { AppPermissionsReflectionProps } from "@/lib/components/policy-reflect";

// The App Permissions panel (step 9.7b): a READ-ONLY reflection of what
// the enforced Policy rules decide per catalog tool — the panel's editing moved
// to the Policy console. Keeps the legacy panel's skeleton (header + agent
// scope select + grouped rows) so the surface stays familiar; the segmented
// editor buttons become display-only verdict pills.

const GROUP_LABELS: Record<string, string> = {
  read: "Read-only",
  write: "Write / delete",
};

const VERDICT_META = {
  allow: {
    label: "Allowed",
    icon: CircleCheck,
    className:
      "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400",
  },
  approval: {
    label: "Needs approval",
    icon: Hand,
    className:
      "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400",
  },
  block: {
    label: "Blocked",
    icon: Ban,
    className: "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  },
  mixed: { label: "Varies", className: "bg-muted text-muted-foreground" },
  unmanaged: {
    label: "Not managed",
    className: "bg-muted text-muted-foreground",
  },
} as const satisfies Record<
  EffectiveToolVerdict,
  { label: string; className: string; icon?: typeof CircleCheck }
>;

/** Display-only verdict pill (deliberately NOT a disabled button — it stays in
 * the a11y tree with its text label; nothing here is interactive). */
const VerdictPill = ({ verdict }: { verdict: EffectiveToolVerdict }) => {
  const meta = VERDICT_META[verdict];
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

const provenanceLine = (tool: EffectiveToolResult): string | null => {
  const p: EffectiveProvenance | null = tool.decidedBy;
  if (p) {
    if (p.kind === "default")
      return `Decided by the ${p.scope === "organization" ? "organization" : "project"} Default Rule`;
    if ("redacted" in p) return "Decided by an organization rule";
    return `Decided by rule · ${p.rule.name}`;
  }
  if (tool.verdict === "mixed") return "Differs across this tool's endpoints";
  if (tool.verdict === "unmanaged")
    return "No rule applies — traffic passes unmanaged";
  if (tool.verdict === "allow") return "Allowed by default";
  return null;
};

export const AppPermissionsReflection = ({
  provider,
  appName,
  pageScope = "project",
}: AppPermissionsReflectionProps) => {
  const pathname = usePathname();
  const agentScoping = pageScope === "project";
  const [agentId, setAgentId] = useState("");
  const { data: agents = [] } = useAgents(agentScoping);
  const { data: definitions = [] } = useAppPermissionDefinitions();
  const definition = definitions.find((d) => d.provider === provider);
  const {
    data: effective,
    isPending,
    isError,
  } = useEffectiveAppPermissions(provider, agentId || null, pageScope);

  const policyHref =
    pageScope === "organization"
      ? withOrgPrefix(pathname, "/policy")
      : withProjectPrefix(pathname, "/policy");

  const selectedAgent = agents.find((a) => a.id === agentId);
  const verdictByTool = new Map(
    (effective?.groups ?? []).flatMap((g) =>
      g.tools.map((t) => [t.toolId, t] as const),
    ),
  );
  const groupVerdicts = new Map(
    (effective?.groups ?? []).map((g) => [g.category, g.verdict] as const),
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Permissions</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {selectedAgent
              ? `Effective access for ${selectedAgent.name}, decided by Policy rules.`
              : agentScoping
                ? "Effective baseline for every agent, decided by Policy rules."
                : "Effective organization guardrails, decided by Policy rules."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {agentScoping && agents.length > 0 && (
            <AgentScopeSelect
              agents={agents.map((a) => ({ id: a.id, name: a.name }))}
              value={agentId}
              onChange={setAgentId}
              triggerClassName="h-7 w-auto gap-1.5 bg-card px-2.5 text-xs"
              ariaLabel="Show effective permissions for agent"
            />
          )}
          <Link
            href={policyHref}
            className="inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
          >
            Manage in Policy
            <ChevronRight className="size-3 opacity-60" aria-hidden="true" />
          </Link>
        </div>
      </div>

      {effective && !agentId && (effective.variesByIdentity ?? 0) > 0 && (
        <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            {effective.variesByIdentity}{" "}
            {effective.variesByIdentity === 1 ? "rule applies" : "rules apply"}{" "}
            only to specific agents or groups
            {agentScoping ? " — select an agent to include them." : "."}
          </span>
        </div>
      )}
      {effective && !effective.basis.credentialAttached && (
        <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            No credential is attached for this app
            {selectedAgent ? ` and ${selectedAgent.name}` : ""} — unmatched
            traffic passes unmanaged until one is connected.
          </span>
        </div>
      )}

      {isPending ? (
        <div className="flex items-center justify-center py-8">
          <Loader2
            className="size-5 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
          <span className="sr-only">Loading effective permissions…</span>
        </div>
      ) : isError ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          Couldn&apos;t load the effective permissions for {appName}.
        </div>
      ) : definition ? (
        <Accordion
          type="multiple"
          defaultValue={definition.groups.map((g) => g.category)}
        >
          {definition.groups.map((group) => {
            const groupVerdict = groupVerdicts.get(group.category);
            return (
              <AccordionItem
                key={group.category}
                value={group.category}
                className="border-b-0"
              >
                <AccordionTrigger className="py-3 hover:no-underline">
                  <span className="flex w-full items-center justify-between gap-2 pr-2">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {GROUP_LABELS[group.category] ?? group.category}
                      <span className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
                        {group.tools.length}
                      </span>
                    </span>
                    {groupVerdict && <VerdictPill verdict={groupVerdict} />}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="pb-1">
                  {group.tools.map((tool) => {
                    const result = verdictByTool.get(tool.id);
                    const line = result ? provenanceLine(result) : null;
                    return (
                      <div
                        key={tool.id}
                        className="flex items-center justify-between gap-3 border-b py-2.5 last:border-b-0"
                      >
                        <div className="min-w-0">
                          <p className="text-sm leading-tight">{tool.name}</p>
                          {line && (
                            <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
                              {line}
                            </p>
                          )}
                        </div>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {result?.rateLimit != null && (
                            <span className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                              <Gauge className="size-3" aria-hidden="true" />
                              {result.rateLimit}/
                              {result.rateLimitWindow === "hour"
                                ? "hr"
                                : result.rateLimitWindow === "day"
                                  ? "day"
                                  : "min"}
                            </span>
                          )}
                          {result && <VerdictPill verdict={result.verdict} />}
                        </span>
                      </div>
                    );
                  })}
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      ) : null}
    </div>
  );
};
