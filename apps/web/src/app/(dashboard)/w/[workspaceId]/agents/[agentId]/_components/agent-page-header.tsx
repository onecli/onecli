"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { AgentAvatarEditor } from "@/lib/agents/_components/agent-avatar-editor";
import { Button } from "@onecli/ui/components/button";
import { withWorkspacePrefix } from "@/lib/navigation";
import { useHostedAvailability } from "@/hooks/use-hosted-availability";
import { AgentStatusPill } from "@/lib/agents/_components/agent-status-pill";
import { CredentialAccessReflection } from "@/lib/components/policy-reflect";
import { AgentActionsMenu } from "../../_components/agent-actions-menu";
import { AgentDetailsDialog } from "./agent-details-dialog";
import type { AgentPageAgent } from "./agent-page-frame";

interface AgentPageHeaderProps {
  agent: AgentPageAgent;
}

/**
 * One compact row: who this page is about, and the door back. Status renders
 * through the one shared pill (§3.18 rule 1 — card, chat, agent page: same
 * component, same vocabulary), and only for hosted agents.
 */
export const AgentPageHeader = ({ agent }: AgentPageHeaderProps) => {
  const pathname = usePathname();
  const router = useRouter();
  const [accessDialogOpen, setAccessDialogOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Read, not polled: the chat section owns the poll; the shared cache is
  // fresh enough for a header pill.
  const availability = useHostedAvailability();

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
      <Button
        variant="ghost"
        size="icon-sm"
        asChild
        aria-label="Back to Agents"
      >
        <Link href={withWorkspacePrefix(pathname, "/agents")}>
          <ArrowLeft className="size-4" />
        </Link>
      </Button>
      <AgentAvatarEditor agent={agent} />
      <div className="flex min-w-0 items-center gap-2.5">
        <h1 className="truncate text-base font-semibold tracking-tight">
          {agent.name}
        </h1>
        {agent.kind === "hosted" && (
          <AgentStatusPill
            availability={availability}
            workingInBackground={agent.workingInBackground}
          />
        )}
        <code className="bg-muted text-muted-foreground hidden rounded px-1.5 py-0.5 font-mono text-xs sm:inline">
          {agent.identifier}
        </code>
      </div>
      <div className="ml-auto">
        <AgentActionsMenu
          agent={agent}
          onCredentialAccess={() => setAccessDialogOpen(true)}
          onDetails={() => setDetailsOpen(true)}
          onDeleted={() =>
            router.push(withWorkspacePrefix(pathname, "/agents"))
          }
        />
      </div>

      <AgentDetailsDialog
        agent={agent}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      />

      <CredentialAccessReflection
        agent={{ id: agent.id, name: agent.name }}
        open={accessDialogOpen}
        onOpenChange={setAccessDialogOpen}
      />
    </div>
  );
};
