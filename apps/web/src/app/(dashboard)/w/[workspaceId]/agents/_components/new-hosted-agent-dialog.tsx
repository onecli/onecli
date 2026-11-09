"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Dices, Plus, X } from "lucide-react";
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
import {
  useAgents,
  useCreateHostedAgent,
  useSetStarterFace,
} from "@/hooks/use-agents";
import { randomAgentName } from "@/lib/agents/agent-names";
import { agentFaceUrl, randomAgentFace } from "@/lib/agents/agent-faces";
import { useHostedAvailability } from "@/hooks/use-hosted-availability";
import {
  OFFLINE_CREATE_MESSAGE,
  hostedCreateRefusalCopy,
} from "@/lib/agents/availability";
import { SecretDialog } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/secret-dialog";
import { useHasConnectionsToChoose } from "@/hooks/use-counts";
import { ChooseConnectionsDialog } from "./choose-connections-dialog";

interface NewHostedAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The agent creation just made, carried through the steps that follow. */
type CreatedAgentRef = { id: string; name: string };

/**
 * Creating a hosted agent: ONE question, a name, and then you're in the chat.
 * It opens on a random name from a list of famous assistants and a random
 * robot picture; Shuffle rolls another pair, and the name stays editable.
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
  const createAgent = useCreateHostedAgent();
  // The submit door, closed from the first submit until the request settles.
  // `createAgent.isPending` is a render-time value: a second submit inside
  // the same tick (Enter and a click that lands together, a double Enter)
  // runs before React re-renders and would send a second POST, which the
  // server answers 409 on the derived identifier.
  const submittingRef = useRef(false);
  const setStarterFace = useSetStarterFace();

  const [name, setName] = useState("");
  const [face, setFace] = useState<number | null>(null);
  const [nameTouched, setNameTouched] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [briefOpen, setBriefOpen] = useState(false);
  // What follows creation, in order, each step only when it has something to
  // do, and the chat last (the agent exists either way):
  //  1. A hosted agent with no LLM key cannot answer at all, so the key is
  //     asked for first. Saving one or dismissing both go on.
  //  2. A new agent starts with no connection, so the user chooses them,
  //     when the workspace has any to offer.
  const [keyFor, setKeyFor] = useState<CreatedAgentRef | null>(null);
  const [choosingFor, setChoosingFor] = useState<CreatedAgentRef | null>(null);
  const hasConnectionsToChoose = useHasConnectionsToChoose();
  const toChat = (agent: CreatedAgentRef) =>
    router.push(agentChatPath(workspaceId, agent.id));
  // Asked when the step is reached, never from the render that scheduled it.
  const afterKey = async (agent: CreatedAgentRef) => {
    if (await hasConnectionsToChoose()) setChoosingFor(agent);
    else toChat(agent);
  };
  const nameInput = useRef<HTMLInputElement>(null);
  // Names already used here: a random pick skips them, so the suggestion
  // never opens on a clash.
  const { data: existingAgents } = useAgents(open);
  const takenNames = (existingAgents ?? []).map((a) => a.name);

  /** Put `next` in the field with the caret at its end (never a selection:
   * selected text is one keystroke from being gone). */
  const fillName = (next: string) => {
    setName(next);
    setNameTouched(false);
    return requestAnimationFrame(() => {
      nameInput.current?.setSelectionRange(next.length, next.length);
    });
  };

  const shuffle = () => {
    fillName(randomAgentName(takenNames, name));
    setFace((current) => randomAgentFace(current));
    nameInput.current?.focus();
  };

  // A random suggestion in the field rather than a blank to fill. Enter
  // accepts it, backspace edits it, the dice roll another. Picked once per
  // opening: the list arriving later must not swap a name being read.
  useEffect(() => {
    if (!open) return;
    setFace(randomAgentFace());
    // After paint: the dialog's autofocus selects the field's contents, so
    // collapsing the caret has to happen once that has already run.
    const id = fillName(randomAgentName(takenNames));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per open
  }, [open]);

  const nameError = validateDisplayName(name);
  const isNameValid = name.trim().length > 0 && nameError === null;
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
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    createAgent.mutate(
      {
        name,
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      },
      {
        onSettled: () => {
          submittingRef.current = false;
        },
        onSuccess: (agent) => {
          // The picked picture becomes the agent's avatar, after the fact:
          // the agent exists either way.
          if (face !== null) setStarterFace(agent.id, face);
          handleClose(false);
          const created = { id: agent.id, name: agent.name };
          // Creating a key server-side attaches it to every keyless agent —
          // which is exactly the agent just created — so saving here is the
          // whole step, with no second attach for the two to disagree about.
          if (agent.llmKeys.length === 0) setKeyFor(created);
          else void afterKey(created);
        },
      },
    );
  };

  const handleClose = (value: boolean) => {
    if (!value) {
      setName("");
      setFace(null);
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
              <div className="flex items-center gap-2">
                {face !== null && (
                  // eslint-disable-next-line @next/next/no-img-element -- a static public asset, already sized
                  <img
                    src={agentFaceUrl(face)}
                    alt=""
                    width={40}
                    height={40}
                    className="size-10 shrink-0 rounded-lg border object-cover"
                  />
                )}
                <Input
                  ref={nameInput}
                  id="hosted-agent-name"
                  placeholder="e.g. Support Triage"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setNameTouched(true)}
                  autoFocus
                  className={cn("h-10", showNameError && "border-destructive")}
                />
                {/* A labelled button in the brand tint, the same 40px as the
                    field: a bare outlined dice read as decoration. */}
                <Button
                  type="button"
                  variant="outline"
                  onClick={shuffle}
                  // The accessible name starts with the visible word, so a
                  // voice-control "click Shuffle" finds it (WCAG 2.5.3).
                  aria-label={
                    face !== null ? "Shuffle name and picture" : "Shuffle name"
                  }
                  title={
                    face !== null
                      ? "Try another name and picture"
                      : "Try another name"
                  }
                  className="border-brand/30 bg-brand-wash text-brand-ink hover:bg-brand-wash/70 hover:text-brand-ink h-10 shrink-0 gap-1.5 px-3"
                >
                  <Dices className="size-4" />
                  Shuffle
                </Button>
              </div>
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
        open={keyFor !== null}
        onOpenChange={(value) => {
          if (value || !keyFor) return;
          setKeyFor(null);
          void afterKey(keyFor);
        }}
        allowedTypes={["anthropic", "openai"]}
        onSaved={() =>
          toast.success("LLM key added and attached to your agent")
        }
      />
      <ChooseConnectionsDialog
        agent={choosingFor}
        onClose={() => {
          if (!choosingFor) return;
          setChoosingFor(null);
          toChat(choosingFor);
        }}
      />
    </>
  );
};
