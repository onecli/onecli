"use client";

import { useState } from "react";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { Textarea } from "@onecli/ui/components/textarea";
import { cn } from "@onecli/ui/lib/utils";
import { BriefExamplePicker } from "@/lib/agents/_components/brief-example-picker";
import { INSTRUCTIONS_MAX_LENGTH } from "@onecli/api/validations/agent";
import { useAgentDetail, useUpdateInstructions } from "@/hooks/use-agents";
import { useAgentPageAgent } from "./agent-page-frame";

/**
 * The agent's brief (§3.11), editable after the fact — the create dialog's
 * field, grown up. Hosted only, which the page frame enforces: the rail never
 * links here for a BYO agent and a hand-typed URL never reaches this far.
 */
export const InstructionsSection = () => {
  const { id: agentId } = useAgentPageAgent();
  const detail = useAgentDetail(agentId);
  const save = useUpdateInstructions();

  const saved = detail.data?.instructions ?? "";
  // null = not editing: the textarea shows the saved value, so the server's
  // copy stays authoritative until the user actually types.
  const [draft, setDraft] = useState<string | null>(null);

  if (detail.isPending) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const value = draft ?? saved;
  const dirty = draft !== null && draft !== saved;
  const tooLong = value.length > INSTRUCTIONS_MAX_LENGTH;

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">What should it do?</h2>
        <p className="text-muted-foreground mt-1 text-xs">
          The brief your agent starts every session with: who it is, what it
          owns, and how it should work.
        </p>
      </div>
      <Textarea
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        rows={12}
        placeholder="e.g. Triage our support inbox and draft replies in my voice. Escalate anything about billing."
        className="resize-y"
        aria-label="Agent instructions"
      />
      {value === "" && <BriefExamplePicker onPick={setDraft} />}
      <div className="flex items-center justify-between gap-4">
        <p
          className={cn(
            "text-xs",
            tooLong ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {tooLong
            ? `Too long: ${value.length.toLocaleString()} of ${INSTRUCTIONS_MAX_LENGTH.toLocaleString()} characters.`
            : "Changes reach the agent the next time it starts up."}
        </p>
        <Button
          size="sm"
          onClick={() =>
            save.mutate(
              // An emptied brief clears the column rather than storing "".
              { agentId, instructions: value.trim() === "" ? null : value },
              { onSuccess: () => setDraft(null) },
            )
          }
          disabled={!dirty || tooLong || save.isPending}
          loading={save.isPending}
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
};
