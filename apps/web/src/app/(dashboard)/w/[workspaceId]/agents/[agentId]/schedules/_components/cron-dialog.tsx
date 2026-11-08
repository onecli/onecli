"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { Switch } from "@onecli/ui/components/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { Info } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { agentChatDraftPath } from "@/lib/navigation";

import { Textarea } from "@onecli/ui/components/textarea";
import { useCreateCron, useDeleteCron, useUpdateCron } from "@/hooks/use-crons";
import type { AgentCron } from "@/lib/api";
import { browserTimezone } from "@/lib/agents/schedule-timezone";
import {
  ScheduleWhenField,
  useScheduleWhen,
  whenFrom,
  type ScheduleWhen,
} from "./schedule-when-field";
import { ScheduleDialogFrame } from "./schedule-dialog-frame";
import { ScheduleAdvanced } from "./schedule-advanced";
import { ScheduleTimezoneField } from "./schedule-timezone-field";
import { DisabledReason } from "./disabled-reason";
import { AskAgentLink } from "./ask-agent-link";

/** The chat draft that hands a schedule's run condition to the agent. */
const setUpConditionDraft = (name: string) =>
  `For the schedule "${name}", only run it when `;

/**
 * Create/edit a task schedule: a name, what to do, and When (the shared
 * `ScheduleWhenField`). The server (croner) stays the validator; its
 * message surfaces verbatim on refusal.
 */

export interface CronDialogProps {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null = create. */
  editing: AgentCron | null;
}

export const CronDialog = ({
  agentId,
  open,
  onOpenChange,
  editing,
}: CronDialogProps) => {
  const create = useCreateCron(agentId);
  const update = useUpdateCron(agentId);
  const remove = useDeleteCron(agentId);

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  // The run condition is set by the agent; here it can only be turned off.
  const [keepGate, setKeepGate] = useState(true);
  const [when, setWhen] = useState<ScheduleWhen>(() => whenFrom(null));
  const [timezone, setTimezone] = useState(browserTimezone());

  // Re-seed the form whenever the dialog opens on a different target.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name);
      setPrompt(editing.prompt);
      setKeepGate(true);
      setTimezone(editing.timezone);
      setWhen(whenFrom(editing.schedule));
    } else {
      setName("");
      setPrompt("");
      setWhen(whenFrom(null));
      setTimezone(browserTimezone());
    }
  }, [open, editing]);

  const read = useScheduleWhen(agentId, when, timezone);

  // A save holds the dialog (the server validates it); a delete is instant.
  const busy = create.isPending || update.isPending;
  // Saving needs a name, a task and a When it understood: both save buttons
  // share this.
  const canSave =
    name.trim() !== "" && prompt.trim() !== "" && read.expression !== null;
  const router = useRouter();
  const pathname = usePathname();
  // A double click (or Enter + click) must never save twice: the pending flag
  // only flips after the request is under way, this ref flips at once.
  const submitting = useRef(false);

  const submit = (then?: (saved: { name: string }) => void) => {
    const expression = read.expression;
    // Both save buttons are disabled until the When is understood.
    if (submitting.current || !expression) return;
    const input = {
      name: name.trim(),
      prompt: prompt.trim(),
      // Sent only to remove it; otherwise an edit leaves the check as is.
      ...(editing?.gate && !keepGate && { gate: null }),
      schedule: expression,
      timezone: timezone.trim(),
    };
    submitting.current = true;
    const handlers = {
      onSuccess: () => {
        submitting.current = false;
        toast.success(editing ? "Schedule updated" : "Schedule created");
        onOpenChange(false);
        then?.({ name: input.name });
      },
      onError: (error: Error) => {
        submitting.current = false;
        toast.error(String(error.message));
      },
    };
    if (editing) {
      update.mutate({ cronId: editing.id, input }, handlers);
    } else {
      create.mutate(input, handlers);
    }
  };

  return (
    <ScheduleDialogFrame
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? "Edit schedule" : "New schedule"}
      // A new schedule reports to the creator's own chat; an edited one keeps
      // reporting where it was created (an agent-made or a teammate's
      // schedule reports elsewhere).
      description={
        editing
          ? "The agent runs this on schedule and reports back to the chat the schedule was created from."
          : "The agent runs this on schedule and sends the result to your chat with it."
      }
      busy={busy}
      saving={create.isPending || update.isPending}
      canSave={canSave}
      saveLabel={editing ? "Save" : "Create"}
      onSave={() => submit()}
      {...(editing && {
        // Instant: the row leaves the list and the dialog closes on click;
        // the hook confirms, or puts the row back and says why.
        onDelete: () => {
          remove.mutate(editing.id);
          onOpenChange(false);
        },
      })}
    >
      <div className="space-y-1.5">
        <Label htmlFor="cron-name">Name</Label>
        <Input
          id="cron-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Daily inbox check"
          maxLength={100}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cron-prompt">What should it do?</Label>
        <Textarea
          id="cron-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Check the support inbox and summarize anything urgent."
          rows={3}
          // `field-sizing-content` grows this field with what you type, so
          // it needs a ceiling of its own: uncapped, a long prompt claims
          // the whole body and pushes the schedule fields out of reach.
          className="max-h-[min(18rem,32dvh)]"
          maxLength={10_000}
        />
      </div>

      <ScheduleWhenField
        id="cron-when"
        when={when}
        onChange={setWhen}
        hint={read.hint}
        hintIsError={read.hintIsError}
        expression={read.expression}
      />

      {/* Open from the start when a run condition is set: it changes
          what the schedule does, so it is never folded out of sight. */}
      <ScheduleAdvanced
        defaultOpen={Boolean(editing?.gate)}
        summary={`${timezone.replace(/_/g, " ")}, ${editing?.gate && keepGate ? "only when needed" : "always runs"}`}
      >
        <ScheduleTimezoneField
          id="cron-tz"
          value={timezone}
          onChange={setTimezone}
        />

        {/* The run condition is the agent's to write: it knows the files
            and APIs, and a typed command that is missing or wrong fails
            every run. Here a person only sees it, and can turn it off. */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <Label htmlFor="cron-gated">Only run when</Label>
              {editing?.gate && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="About run conditions"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Info className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-64">
                    A free check runs first and skips the run when nothing
                    changed. Check:{" "}
                    <code className="font-mono">{editing.gate}</code>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            {editing?.gate && (
              <Switch
                id="cron-gated"
                checked={keepGate}
                onCheckedChange={setKeepGate}
              />
            )}
          </div>
          {editing?.gate ? (
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate text-muted-foreground">
                {editing.gateDescription ?? editing.gate}
              </span>
              <AskAgentLink
                agentId={agentId}
                label="Change"
                draft={`For the schedule "${editing.name}", change when it runs.\nNow it only runs when: ${editing.gateDescription ?? editing.gate}\nChange it to only run when: `}
              />
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">
                Always. The agent can add a check that skips runs when nothing
                changed.
              </span>
              {editing ? (
                canSave ? (
                  <Link
                    href={agentChatDraftPath(
                      pathname,
                      agentId,
                      setUpConditionDraft(editing.name),
                    )}
                    className="focus-visible:ring-ring/50 shrink-0 rounded-sm text-xs font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2"
                  >
                    Set up with agent
                  </Link>
                ) : null
              ) : (
                // A new schedule is saved first, so the agent edits a real
                // one (update_task) instead of creating a second. A disabled
                // button gets no pointer events, so the reason rides the
                // wrapper's tooltip.
                <DisabledReason
                  reason={
                    canSave
                      ? null
                      : "Fill in the name, the task and When first."
                  }
                >
                  <button
                    type="button"
                    className="focus-visible:ring-ring/50 shrink-0 rounded-sm text-xs font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50"
                    disabled={!canSave || busy}
                    onClick={() =>
                      submit((saved) =>
                        router.push(
                          agentChatDraftPath(
                            pathname,
                            agentId,
                            setUpConditionDraft(saved.name),
                          ),
                        ),
                      )
                    }
                  >
                    Create & set up with agent
                  </button>
                </DisabledReason>
              )}
            </div>
          )}
        </div>
      </ScheduleAdvanced>
    </ScheduleDialogFrame>
  );
};
