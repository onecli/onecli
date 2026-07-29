"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Ban,
  Bot,
  CircleCheck,
  CircleMinus,
  Hand,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { cn } from "@onecli/ui/lib/utils";
import type {
  AgentAccessStatus,
  AgentCredentialStatus,
  EffectiveAgentEntry,
} from "@/lib/api/policy-visibility";
import { withProjectPrefix } from "@/lib/navigation";
import { useConnectionEffectiveAgents } from "@/lib/api/policy-visibility";
import type { ConnectionAgentsReflectionProps } from "@/lib/components/policy-reflect";

// The connection "agent access" dialog (step 9.7b), framed around
// EFFECTIVE access (the user decision — lead with what the agent can DO, not
// whether a credential is attached). Each agent row headlines its access
// (Can use / Limited / Blocked / No access) with the tool count + how the
// credential attaches as secondary detail.

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

/** How the credential attaches — the secondary line under the agent name. */
const attachDetail = (credential: AgentCredentialStatus): string | null => {
  switch (credential.status) {
    case "full":
      return "All-credentials mode";
    case "viaRule": {
      const named = credential.provenance.flatMap((p) =>
        p.kind === "rule" && "rule" in p ? [p.rule.name] : [],
      );
      if (named.length) return `Granted by ${named.join(", ")}`;
      return credential.provenance.some(
        (p) => p.kind === "rule" && "redacted" in p,
      )
        ? "Granted by an organization rule"
        : null;
    }
    case "none":
      return "No credential attached";
  }
};

export const ConnectionAgentsReflection = ({
  connectionId,
  connectionLabel,
  appName,
  open,
  onOpenChange,
}: ConnectionAgentsReflectionProps) => {
  const pathname = usePathname();
  const {
    data: result,
    isPending,
    isError,
  } = useConnectionEffectiveAgents(connectionId, open);
  const policyHref = withProjectPrefix(pathname, "/policy");

  const toolCount = (agent: EffectiveAgentEntry): string | null =>
    agent.decisions && agent.credential.status !== "none"
      ? `${agent.decisions.allowedTools} of ${agent.decisions.totalTools} tools`
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle>Agent access for {connectionLabel}</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            What each agent can do with this {appName} connection, decided by
            Policy rules.
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-2">
          {isPending ? (
            <div className="flex items-center justify-center py-10">
              <Loader2
                className="size-5 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
              <span className="sr-only">Loading agent access…</span>
            </div>
          ) : isError ? (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            >
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
              Couldn&apos;t load agent access for this connection.
            </div>
          ) : !result || result.agents.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                <Bot
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
              </div>
              <div>
                <p className="text-sm font-medium">No agents yet</p>
                <p className="text-xs text-muted-foreground">
                  Create an agent to route traffic through the gateway.
                </p>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link href={withProjectPrefix(pathname, "/agents")}>
                  Go to Agents
                </Link>
              </Button>
            </div>
          ) : (
            <>
              {!result.catalog && (
                <p className="mb-1 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  This app has no permission catalog — access is governed by
                  network rules only.
                </p>
              )}
              {/* Native max-height scroller (not a Radix ScrollArea, which clips
                  under a max-height) so a long agent list stays reachable. */}
              <div className="max-h-[min(24rem,50vh)] divide-y overflow-y-auto overscroll-contain">
                {result.agents.map((agent) => {
                  const detail = attachDetail(agent.credential);
                  const tools = toolCount(agent);
                  return (
                    <div
                      key={agent.agentId}
                      className="flex items-center justify-between gap-3 py-2.5"
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted">
                          <Bot
                            className="size-3.5 text-muted-foreground"
                            aria-hidden="true"
                          />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm">
                            {agent.name}
                          </span>
                          {detail && (
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {detail}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {tools && (
                          <span className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] text-muted-foreground tabular-nums">
                            {tools}
                            {agent.decisions?.anyApproval && (
                              <>
                                <Hand className="size-3" aria-hidden="true" />
                                <span className="sr-only">
                                  , some need approval
                                </span>
                              </>
                            )}
                          </span>
                        )}
                        <AccessPill access={agent.access} />
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <DialogFooter className="border-border/50 border-t px-6 py-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button asChild>
            <Link href={policyHref}>Manage in Policy</Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
