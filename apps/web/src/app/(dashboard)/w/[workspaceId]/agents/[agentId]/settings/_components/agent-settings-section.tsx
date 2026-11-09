"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { PageHeader } from "@dashboard/page-header";
import { useInstance } from "@/hooks/use-instance";
import { ScrollToHash } from "@/lib/dashboard/scroll-to-hash";
import { withWorkspacePrefix } from "@/lib/navigation";
import { useAgentPageAgent } from "../../_components/agent-page-frame";
import { AgentFacts } from "../../_components/agent-details-dialog";
import { ModelsSection } from "../../_components/models-section";
import { SshSection } from "../../ssh/_components/ssh-section";
import { PageBlock } from "../../_components/page-block";
import { DeleteAgentDialog } from "../../../_components/delete-agent-dialog";

/**
 * Agent settings, under More: what the
 * agent runs on (the old Models page), the shell into its computer (the
 * old SSH page, hosted agents on deployments with the SSH front door) and
 * its facts (the kebab's Details dialog, now also a place). Rename, restart
 * and delete stay in the top bar's kebab, one click from any page; delete is
 * also the last block here (Danger zone), where people look for it.
 *
 * Blocks are anchored by the old section name so the old URLs land on the
 * right one (`/models` forwards to `/settings#models`).
 */
export const AgentSettingsSection = () => {
  const agent = useAgentPageAgent();
  const instance = useInstance();
  // The rail's gate, verbatim: SSH exists only where the deployment has the
  // front door; while the instance loads the block shows (loading must
  // never render as unavailable).
  const ssh =
    agent.kind === "hosted" &&
    (instance === null || instance.ssh !== undefined);

  return (
    <div className="space-y-10">
      <ScrollToHash />
      <PageHeader
        title="Agent settings"
        character="cloud-list"
        description={`What ${agent.name} runs on, and how to reach its computer.`}
      />
      <PageBlock id="models" title="Model">
        <ModelsSection agentId={agent.id} hosted={agent.kind === "hosted"} />
      </PageBlock>
      {ssh && (
        <PageBlock id="ssh" title="Computer access">
          <SshSection heading={false} />
        </PageBlock>
      )}
      <PageBlock id="details" title="Details">
        <AgentFacts agent={agent} live />
      </PageBlock>
      <DangerZone agent={agent} />
    </div>
  );
};

/** Deleting the agent, last on the page and set apart in red. The confirm is
 * the kebab's own dialog (`DeleteAgentDialog`), Slack acknowledgements
 * included; after a delete the person lands on the workspace home, as from
 * the kebab. */
const DangerZone = ({
  agent,
}: {
  agent: ReturnType<typeof useAgentPageAgent>;
}) => {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  return (
    <section
      id="delete"
      aria-labelledby="delete-heading"
      className="border-destructive/30 flex scroll-mt-6 flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3"
    >
      <div className="min-w-0">
        <h2
          id="delete-heading"
          className="text-destructive text-sm font-semibold"
        >
          Danger zone
        </h2>
        <p className="text-muted-foreground text-sm">
          Permanently delete {agent.name} and its access. This can&apos;t be
          undone.
        </p>
      </div>
      <Button
        variant="destructive"
        size="sm"
        onClick={() => setOpen(true)}
        className="shrink-0"
      >
        <Trash2 className="size-3.5" aria-hidden />
        Delete agent
      </Button>
      <DeleteAgentDialog
        agent={agent}
        open={open}
        onOpenChange={setOpen}
        onDeleted={() => router.replace(withWorkspacePrefix(pathname, ""))}
      />
    </section>
  );
};
