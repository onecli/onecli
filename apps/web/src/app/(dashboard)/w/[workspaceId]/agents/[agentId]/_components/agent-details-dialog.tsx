"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { useAgentModels } from "@/hooks/use-agents";
import { useHostedAvailability } from "@/hooks/use-hosted-availability";
import { AgentStatusPill } from "@/lib/agents/_components/agent-status-pill";
import { AgentLastSeen } from "@/lib/agents/_components/agent-last-seen";
import type { AgentPageAgent } from "./agent-page-frame";

const Row = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <div className="flex items-center justify-between gap-4 py-2.5">
    <dt className="text-muted-foreground text-sm">{label}</dt>
    <dd className="min-w-0 text-right text-sm">{children}</dd>
  </div>
);

/**
 * The agent's facts, as a dialog off the header menu ("Details") rather than
 * a rail section: they are reference, not a place — reading them should never
 * cost you the section you were in. Nothing operational lives here (actions
 * are the menu, access is Connections, the thread is Chat); status vocabulary
 * is the shared pill (§3.18 rule 1) and the harness deliberately never
 * appears (infrastructure words stay out of the UI, §3.13).
 */
export const AgentDetailsDialog = ({
  agent,
  open,
  onOpenChange,
}: {
  agent: AgentPageAgent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const hosted = agent.kind === "hosted";
  const availability = useHostedAvailability();
  // The RESOLVED model, not `Agent.model` — that column holds only an
  // override, so reading it directly renders "–" for every healthy agent
  // (§3.10). Hosted-only, and only while the dialog is open: closed, it costs
  // nothing.
  const models = useAgentModels(hosted && open ? agent.id : "");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Details</DialogTitle>
          <DialogDescription>
            Read-only facts about this agent.
          </DialogDescription>
        </DialogHeader>
        <dl className="divide-border divide-y">
          {hosted && (
            <Row label="Status">
              <AgentStatusPill
                availability={availability}
                workingInBackground={agent.workingInBackground}
              />
            </Row>
          )}
          {hosted && (
            <Row label="Model">
              {/* `||`, not `??`: with no key granted the view is empty rather
                  than null, and an empty string would render a blank row. */}
              <span className="inline-block max-w-full truncate align-bottom">
                {models.data?.selected.model || "–"}
              </span>
              {models.data?.provider && !models.data.selected.overridden && (
                <span className="text-muted-foreground ml-1.5 shrink-0 text-xs">
                  default
                </span>
              )}
            </Row>
          )}
          <Row label="Identifier">
            <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
              {agent.identifier}
            </code>
          </Row>
          <Row label="Created">
            {new Date(agent.createdAt).toLocaleDateString()}
          </Row>
          <Row label="Last seen">
            <AgentLastSeen
              lastSeenAt={agent.lastSeenAt}
              createdAt={agent.createdAt}
            />
          </Row>
        </dl>
      </DialogContent>
    </Dialog>
  );
};
