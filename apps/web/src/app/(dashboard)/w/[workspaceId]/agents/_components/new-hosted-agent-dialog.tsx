"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { Textarea } from "@onecli/ui/components/textarea";
import { cn } from "@onecli/ui/lib/utils";
import { validateDisplayName } from "@onecli/api/validations/display-name";
import { INSTRUCTIONS_MAX_LENGTH } from "@onecli/api/validations/agent";
import { agentChatPath } from "@/lib/navigation";
import { nameToIdentifier } from "@/lib/agents/agent-identifier";
import { useCreateHostedAgent } from "@/hooks/use-agents";
import {
  useHomeDurabilityMessage,
  useHostedAvailability,
} from "@/hooks/use-hosted-availability";
import {
  OFFLINE_CREATE_MESSAGE,
  hostedCreateRefusalCopy,
} from "@/lib/agents/availability";
import { SecretDialog } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/secret-dialog";

interface NewHostedAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The name the field opens with, so nobody faces an empty required box. */
const DEFAULT_AGENT_NAME = "Donna";

/**
 * Creating a hosted agent: ONE question, a name, and then you're in the chat.
 *
 * Everything else an agent has — its brief, its connections, its model — is a
 * section of the agent page that can be changed at any time, so asking up
 * front only buys a form between the user and the thing they came for. The
 * brief sits behind a disclosure for the person who already knows what they
 * want.
 *
 * No success step: creation navigates straight to Chat (§3.18 — the agent IS
 * the thread), and a turn sent before the agent is up is queued, not refused.
 */
export const NewHostedAgentDialog = ({
  open,
  onOpenChange,
}: NewHostedAgentDialogProps) => {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const availability = useHostedAvailability();
  // Same shared cache entry as the availability hook — no extra request. The
  // one place agent-file durability is stated (§3.9), in agent words only.
  const durabilityNote = useHomeDurabilityMessage();
  const createAgent = useCreateHostedAgent();

  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [briefOpen, setBriefOpen] = useState(false);
  // A hosted agent with no LLM key cannot answer at all, so landing straight
  // in the chat would land in a dead room. The key is asked for INSTEAD of
  // the navigation, never as a step in front of it: saving one goes on to the
  // chat, and dismissing goes there too — the agent exists either way.
  const [pendingChatAgentId, setPendingChatAgentId] = useState<string | null>(
    null,
  );
  const nameInput = useRef<HTMLInputElement>(null);

  // A default in the field rather than a blank to fill, with the caret parked
  // at its end — Enter accepts it, backspace edits it. Caret, never a
  // selection: selected text is one keystroke from being gone.
  useEffect(() => {
    if (!open) return;
    setName(DEFAULT_AGENT_NAME);
    // After paint: the dialog's autofocus selects the field's contents, so
    // collapsing the caret has to happen once that has already run.
    const id = requestAnimationFrame(() => {
      const end = DEFAULT_AGENT_NAME.length;
      nameInput.current?.setSelectionRange(end, end);
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  const nameError = validateDisplayName(name);
  const identifier = nameToIdentifier(name);
  const isNameValid =
    name.trim().length > 0 && nameError === null && identifier.length > 0;
  const showNameError = nameTouched && name.length > 0 && nameError !== null;
  const briefTooLong = instructions.length > INSTRUCTIONS_MAX_LENGTH;
  // Creation genuinely needs a live agent host (the server 422s without one).
  // Only the explicit OFFLINE state gates — `loading` must never read as
  // unavailable (§3.13), so it stays submittable and the 422 copy covers the
  // race.
  const offline = availability === "offline";
  const canSubmit =
    isNameValid && !briefTooLong && !offline && !createAgent.isPending;

  const handleCreate = () => {
    setNameTouched(true);
    if (!canSubmit) return;
    createAgent.mutate(
      {
        name,
        identifier,
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      },
      {
        onSuccess: (agent) => {
          handleClose(false);
          // Creating a key server-side attaches it to every keyless agent —
          // which is exactly the agent just created — so saving here is the
          // whole step, with no second attach for the two to disagree about.
          if (agent.llmKeys.length === 0) {
            setPendingChatAgentId(agent.id);
            return;
          }
          router.push(agentChatPath(workspaceId, agent.id));
        },
      },
    );
  };

  const handleClose = (value: boolean) => {
    if (!value) {
      setName("");
      setNameTouched(false);
      setInstructions("");
      setBriefOpen(false);
      createAgent.reset();
    }
    onOpenChange(value);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New agent</DialogTitle>
            <DialogDescription>
              Keep the name or pick your own. You can tell it what to do in the
              chat.
            </DialogDescription>
          </DialogHeader>

          {/* A form, so Enter submits — the whole point of a one-field dialog is
            that it can be answered without reaching for the mouse. */}
          <form
            className="space-y-3 py-1"
            onSubmit={(e) => {
              e.preventDefault();
              handleCreate();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="hosted-agent-name" className="sr-only">
                Name
              </Label>
              <Input
                ref={nameInput}
                id="hosted-agent-name"
                placeholder="e.g. Support Triage"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setNameTouched(true)}
                autoFocus
                className={cn(showNameError && "border-destructive")}
              />
              {showNameError && (
                <p className="text-destructive text-xs">{nameError}</p>
              )}
            </div>

            {/* Opt-in and reversible — opening it is a look, not a commitment.
              Closing DISCARDS the text rather than hiding it, so nothing can
              be submitted that isn't on screen; the label says so, and the
              brief is one field on the agent page away regardless. */}
            {briefOpen ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label
                    htmlFor="hosted-agent-instructions"
                    className="text-muted-foreground text-xs"
                  >
                    What should it do?
                  </Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground -mr-2 h-6 px-2 text-xs"
                    // The visible word is short enough to sit beside the label;
                    // the accessible name says what it acts on, since "Discard"
                    // alone is ambiguous read out of context.
                    aria-label={
                      instructions.trim()
                        ? "Discard the brief"
                        : "Remove the brief"
                    }
                    onClick={() => {
                      setBriefOpen(false);
                      setInstructions("");
                    }}
                  >
                    <X className="size-3" />
                    {instructions.trim() ? "Discard" : "Remove"}
                  </Button>
                </div>
                <Textarea
                  id="hosted-agent-instructions"
                  placeholder="e.g. Triage our support inbox and draft replies in my voice. Escalate anything about billing."
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  rows={3}
                  // `resize-none` only removes the drag handle; the field still
                  // grows itself via `field-sizing-content`, so a pasted brief
                  // needs a ceiling or it walks Create off the bottom.
                  className="max-h-[min(14rem,28dvh)] resize-none"
                  autoFocus
                />
                {briefTooLong && (
                  <p className="text-destructive text-xs">
                    Too long: {instructions.length.toLocaleString()} of{" "}
                    {INSTRUCTIONS_MAX_LENGTH.toLocaleString()} characters.
                  </p>
                )}
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground h-7 -ml-2 text-xs"
                onClick={() => setBriefOpen(true)}
              >
                <Plus className="size-3" />
                Add a brief
              </Button>
            )}

            {offline && (
              <p className="text-muted-foreground bg-muted rounded-md px-3 py-2 text-xs">
                {OFFLINE_CREATE_MESSAGE}
              </p>
            )}
            {!offline && durabilityNote && (
              <p className="text-muted-foreground text-xs">{durabilityNote}</p>
            )}
            {createAgent.error && (
              <p className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-xs">
                {hostedCreateRefusalCopy(createAgent.error)}
              </p>
            )}

            <DialogFooter className="pt-3">
              <Button
                type="button"
                variant="ghost"
                onClick={() => handleClose(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                loading={createAgent.isPending}
                disabled={!canSubmit}
              >
                {createAgent.isPending ? "Creating…" : "Create agent"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <SecretDialog
        open={pendingChatAgentId !== null}
        onOpenChange={(value) => {
          if (value) return;
          const agentId = pendingChatAgentId;
          setPendingChatAgentId(null);
          if (agentId) router.push(agentChatPath(workspaceId, agentId));
        }}
        allowedTypes={["anthropic", "openai"]}
        onSaved={() =>
          toast.success("LLM key added and attached to your agent")
        }
      />
    </>
  );
};
