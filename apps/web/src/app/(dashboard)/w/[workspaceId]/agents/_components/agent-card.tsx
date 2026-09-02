"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { KeyRound, MessageSquare, Settings2 } from "lucide-react";
import { Card } from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
import type { AgentGrantsSummary } from "@/lib/api";
import { agentChatPath, agentSectionPath } from "@/lib/navigation";
import { defaultAgentSection } from "@/lib/agents/agent-sections";
import { AgentStatusPill } from "@/lib/agents/_components/agent-status-pill";
import { AgentLastSeen } from "@/lib/agents/_components/agent-last-seen";
import { useHostedAvailability } from "@/hooks/use-hosted-availability";
// The read-only credential-access reflection, which reads the v2 policy
// engine. Shared since step 10 — every edition renders it.
import { CredentialAccessReflection } from "@/lib/components/policy-reflect";
import { AgentActionsMenu } from "./agent-actions-menu";
import { CredentialAvatars } from "./credential-avatars";

interface AgentCardProps {
  agent: {
    id: string;
    name: string;
    identifier: string;
    accessToken: string;
    /** Prisma types the column as `string`; the card only asks "hosted?". */
    kind: string;
    createdAt: Date;
    /** Attached channel presences — the delete confirmation names them. */
    channels?: { provider: string }[];
    lastSeenAt: Date | null;
    /** Live background work is holding this agent's computer up (step 13). */
    workingInBackground?: boolean;
  };
  /** The batched grants-summary entry for this agent (the access cluster);
   * undefined while the summary loads — the cluster simply isn't shown yet. */
  summary?: AgentGrantsSummary;
}

export const AgentCard = ({ agent, summary }: AgentCardProps) => {
  const pathname = usePathname();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  // Straight to the agent's first REAL section, never the bare index: the
  // index is a redirect, so linking to it buys an empty pane while it
  // resolves. Chat for a hosted agent, Connections for a BYO one.
  const openPath = agentSectionPath(
    pathname,
    agent.id,
    defaultAgentSection(agent.kind),
  );
  const [secretsDialogOpen, setSecretsDialogOpen] = useState(false);
  // Read, not polled: the chat surface owns the poll; here the shared cache
  // is fresh enough for a card pill. BYO cards render no pill at all.
  const availability = useHostedAvailability();
  const hosted = agent.kind === "hosted";

  return (
    // The whole card is clickable through the STRETCHED name link (a real
    // <a>, keyboard-reachable — never an onClick div); interactive children
    // sit above the overlay via `relative`.
    <Card className="hover:border-muted-foreground/30 relative p-5 transition-colors">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-64 space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-medium">
              <Link
                href={openPath}
                className="after:absolute after:inset-0 after:content-[''] hover:underline"
              >
                {agent.name}
              </Link>
            </h3>
            {hosted && (
              <AgentStatusPill
                availability={availability}
                workingInBackground={agent.workingInBackground}
              />
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <code className="bg-muted text-muted-foreground relative rounded px-1.5 py-0.5 font-mono">
              {agent.identifier}
            </code>
            <AgentLastSeen
              lastSeenAt={agent.lastSeenAt}
              createdAt={agent.createdAt}
            />
            <span className="text-muted-foreground">
              Created {new Date(agent.createdAt).toLocaleDateString()}
            </span>
            <button
              type="button"
              onClick={() => setSecretsDialogOpen(true)}
              className="text-muted-foreground hover:text-foreground relative inline-flex items-center gap-1.5 transition-colors"
            >
              <KeyRound className="size-3" />
              Credential access
            </button>
          </div>
        </div>

        {/* The access cluster: what this agent can reach, then the door to
            managing it. min-w-0 + wrap so the cluster folds under the name on
            narrow screens instead of overflowing the card. */}
        <div className="relative flex min-w-0 flex-wrap items-center gap-2">
          {summary !== undefined && (
            <CredentialAvatars
              entries={summary.entries}
              total={summary.total}
            />
          )}
          {hosted && (
            // The product's most frequent action, reachable without drilling
            // in (§3.18) — deep-links the agent's direct thread.
            <Button variant="ghost" size="xs" asChild>
              <Link href={agentChatPath(workspaceId, agent.id)}>
                <MessageSquare className="size-3.5" />
                Chat
              </Link>
            </Button>
          )}
          {summary !== undefined && (
            // Ghost like the kebab beside it — quiet shape, full-strength text.
            <Button variant="ghost" size="xs" asChild>
              <Link href={openPath}>
                <Settings2 className="size-3.5" />
                Manage
              </Link>
            </Button>
          )}
          <AgentActionsMenu
            agent={agent}
            onCredentialAccess={() => setSecretsDialogOpen(true)}
          />
        </div>
      </div>

      <CredentialAccessReflection
        agent={{ id: agent.id, name: agent.name }}
        open={secretsDialogOpen}
        onOpenChange={setSecretsDialogOpen}
      />
    </Card>
  );
};
