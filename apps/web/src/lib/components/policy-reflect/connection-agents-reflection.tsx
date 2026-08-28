"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Check, Loader2, TriangleAlert } from "lucide-react";
import { AgentIcon } from "@/lib/agents/agent-icon";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { useConnectionEffectiveAgents } from "@/lib/api/policy-visibility";
import { useConnectionGrants } from "@/hooks/use-grants";
import { withWorkspacePrefix } from "@/lib/navigation";
import type { ConnectionAgentsReflectionProps } from "@/lib/components/policy-reflect";
import { ConnectionAgentAccessRow } from "./connection-agent-access-row";

// The connection "agent access" dialog — EDITABLE since step 4 of the attach
// model: each agent row carries the attach toggle + a Manage deep-link into
// the agent page's permissions sheet, while the effective framing stays
// (lead with what the agent can DO; credential detail is secondary). Writes
// go through the step-2 grants API's connection orientation.
//
// Two ways in, same rows: from an account card, to audit or change an
// established connection; and straight off a successful connect
// (`justConnected`), where it IS the setup step that used to be crammed into
// the 520px OAuth popup.

export const ConnectionAgentsReflection = ({
  connectionId,
  connectionLabel,
  appName,
  open,
  onOpenChange,
  justConnected = false,
}: ConnectionAgentsReflectionProps) => {
  const pathname = usePathname();
  const effectiveQuery = useConnectionEffectiveAgents(connectionId, open);
  const grantsQuery = useConnectionGrants(connectionId, open);

  // Toggles must never render over unknown grant state — both the effective
  // view AND the grants view have to resolve first (the workspace-access rule).
  const isPending = effectiveQuery.isPending || grantsQuery.isPending;
  const isError = effectiveQuery.isError || grantsQuery.isError;
  const result = effectiveQuery.data;
  const grantedAgentIds = new Set(
    (grantsQuery.data?.agents ?? []).map((a) => a.agentId),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="min-w-0 p-6 pb-4">
          {justConnected ? (
            <>
              {/* Follows DialogHeader's own `text-center sm:text-left`, so the
                  title doesn't sit left of a centred description on a phone. */}
              <div className="flex min-w-0 items-center justify-center gap-2.5 sm:justify-start">
                {/* The same mark the connect popup just showed, so the dialog
                    reads as that flow continuing rather than as a new one. */}
                <span
                  className="bg-brand motion-safe:animate-in motion-safe:zoom-in-50 flex size-6 shrink-0 items-center justify-center rounded-full duration-300"
                  aria-hidden="true"
                >
                  <Check className="size-3.5 text-white" strokeWidth={3} />
                </span>
                <DialogTitle className="break-words">
                  {appName} connected
                </DialogTitle>
              </div>
              <DialogDescription className="text-xs leading-relaxed">
                Turn on the agents that should be able to use this connection.
                Changes apply immediately. You can adjust them any time.
              </DialogDescription>
            </>
          ) : (
            <>
              {/* `break-words` is load-bearing, not cosmetic: an account label
                  is an email with no spaces, so without it the title's
                  min-content width sizes the dialog's grid column and drags the
                  whole panel past the viewport on a phone. */}
              <DialogTitle className="break-words">
                Agent access for {connectionLabel}
              </DialogTitle>
              <DialogDescription className="text-xs leading-relaxed">
                Which agents may use this {appName} connection, and what each
                one can do. Changes apply immediately.
              </DialogDescription>
            </>
          )}
        </DialogHeader>

        {/* `min-w-0` on the DIRECT children of DialogContent: they are grid
            items, whose automatic minimum size is their min-content width, so
            without it the widest row (or a long account label) sizes the
            column and the panel overflows the viewport on a phone. */}
        <div className="min-w-0 px-6 pb-2">
          {isPending ? (
            <div className="flex items-center justify-center py-10">
              <Loader2
                className="text-muted-foreground size-5 animate-spin"
                aria-hidden="true"
              />
              <span className="sr-only">Loading agent access…</span>
            </div>
          ) : isError ? (
            <div
              role="alert"
              className="border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
            >
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
              Couldn&apos;t load agent access for this connection.
            </div>
          ) : !result || result.agents.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <div className="bg-muted flex size-10 items-center justify-center rounded-full">
                <AgentIcon
                  className="text-muted-foreground size-4"
                  aria-hidden="true"
                />
              </div>
              <div>
                <p className="text-sm font-medium">No agents yet</p>
                <p className="text-muted-foreground text-xs">
                  Create an agent to route traffic through the gateway.
                </p>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link href={withWorkspacePrefix(pathname, "/agents")}>
                  Go to Agents
                </Link>
              </Button>
            </div>
          ) : (
            <>
              {!result.catalog && (
                <p className="bg-muted/40 text-muted-foreground mb-1 rounded-md border px-3 py-2 text-xs">
                  This app has no permission catalog. Access is governed by
                  network rules only.
                </p>
              )}
              {/* Native max-height scroller (not a Radix ScrollArea, which clips
                  under a max-height) so a long agent list stays reachable. */}
              <div className="max-h-[min(24rem,50vh)] min-w-0 divide-y overflow-y-auto overscroll-contain">
                {result.agents.map((agent) => (
                  <ConnectionAgentAccessRow
                    key={agent.agentId}
                    connectionId={connectionId}
                    agent={agent}
                    workspaceGranted={grantedAgentIds.has(agent.agentId)}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        {/* No "Manage in Policy" escape hatch: the rows self-serve, and the
            workspace policy page is on its way out (step 6) — new UI must not
            advertise a dying surface. */}
        <DialogFooter className="border-border/50 border-t px-6 py-4">
          <Button onClick={() => onOpenChange(false)}>
            {justConnected ? "Done" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
