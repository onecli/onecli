"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useCreateThenAttachSecret } from "@/hooks/use-create-then-attach-secret";
import { useSecrets } from "@/hooks/use-secrets";
import { SecretDialog } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/secret-dialog";
import type { Secret } from "@/lib/api";
import { connectionsPath } from "@/lib/navigation";
import { ModelCard } from "./model-card";
import { SecretGrantsTab } from "./secret-grants-tab";

/**
 * The Models page's client shell: the model picker, the LLM-key grant list,
 * and an in-place "Add LLM key" door. Same create-then-attach contract as the
 * Connections section's door — a key minted here is granted to THIS agent the
 * moment it lands, so fixing a dead key never requires leaving the page the
 * error pointed to.
 */
export const ModelsSection = ({ agentId }: { agentId: string }) => {
  const pathname = usePathname();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Secret | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  // Same pool predicate as SecretGrantsTab's llm kind. While the list is
  // empty (or still loading) the empty state's own door carries the CTA —
  // hiding the header button avoids two identical "Add LLM key" buttons.
  const secretsQuery = useSecrets();
  const hasLlmKeys = (secretsQuery.data ?? []).some(
    (s) => s.type !== "generic",
  );

  // Create-then-attach: a key minted here is granted to THIS agent the
  // moment it lands (the shared SecretActions interception seam).
  const { secretActions, onSaved } = useCreateThenAttachSecret(agentId);

  return (
    <div className="flex flex-col gap-6">
      <ModelCard agentId={agentId} />
      {/* Header + list grouped like the sibling agent sections (schedules,
          memory): the heading belongs to its list, not floating between
          cards. */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">LLM keys</h2>
            <p className="text-muted-foreground text-sm">
              The keys this agent can answer with. The model above runs on
              whichever key is attached.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* The workspace's LLM keys page: every key, every agent it's
                attached to — the management view this per-agent list is a
                slice of. */}
            <Button asChild size="sm" variant="outline">
              <Link href={connectionsPath({ pathname }, "/llms")}>Manage</Link>
            </Button>
            {hasLlmKeys && (
              <Button size="sm" onClick={() => setDialogOpen(true)}>
                <Plus className="size-4" aria-hidden />
                Add LLM key
              </Button>
            )}
          </div>
        </div>
        <SecretGrantsTab
          agentId={agentId}
          kind="llm"
          onAdd={() => setDialogOpen(true)}
          onEdit={(secret) => {
            setEditing(secret);
            setEditOpen(true);
          }}
        />
      </div>
      {/* Create door: attach-on-create. */}
      <SecretDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={onSaved}
        allowedTypes={["anthropic", "openai"]}
        secretActions={secretActions}
      />
      {/* Edit door: replace the stored value (write-only) or rename. Keyed so
          a different row always mounts a fresh form; the row survives the
          close (open flips false) so the exit animation plays. */}
      {editing && (
        <SecretDialog
          key={editing.id}
          open={editOpen}
          onOpenChange={(open) => {
            if (!open) setEditOpen(false);
          }}
          secret={editing}
        />
      )}
    </div>
  );
};
