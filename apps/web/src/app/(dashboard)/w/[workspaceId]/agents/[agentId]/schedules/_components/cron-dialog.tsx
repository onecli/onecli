"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { Switch } from "@onecli/ui/components/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { Filter, Info } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { agentChatDraftPath } from "@/lib/navigation";

import { Textarea } from "@onecli/ui/components/textarea";
import {
  useCreateCron,
  useDeleteCron,
  useParseWords,
  useUpdateCron,
} from "@/hooks/use-crons";
import type { AgentCron } from "@/lib/api";
import { browserTimezone } from "@/lib/agents/schedule-timezone";
import { whenLabel } from "./schedule-grid";
import { AskAgentLink } from "./ask-agent-link";
import {
  cronToHuman,
  humanToCron,
  humanToOnce,
} from "@/lib/agents/human-schedule";

/** The chat draft that hands a schedule's run condition to the agent. */
const setUpConditionDraft = (name: string) =>
  `For the schedule "${name}", only run it when `;

/**
 * Create/edit a schedule. "When" is plain words ("every 5 minutes",
 * "weekdays at 9") read by a rule-based parser that never guesses; the
 * expression it produced is shown under the field before saving. A one-shot
 * date and a raw cron expression are the two alternatives. The server
 * (croner) stays the validator; its message surfaces verbatim on refusal.
 */

type Mode = "words" | "once" | "cron";

/** The one-shot form: an ISO 8601 local datetime (croner reads it as a
 * fire-once pattern in the schedule's timezone; no offset by design — the
 * timezone field governs). */
const ONCE_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

/** A Date as datetime-local's "YYYY-MM-DDTHH:mm", in the browser's zone. */
const localMinute = (date: Date): string => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

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
  const [mode, setMode] = useState<Mode>("words");
  const [words, setWords] = useState("every day at 9");
  const [onceAt, setOnceAt] = useState("");
  // "Now", taken when a time is picked (render stays pure): a one-shot
  // already past would never fire.
  const [pickedAt, setPickedAt] = useState(0);
  // Called from event handlers only, with the handler's own clock reading.
  const pickOnce = (value: string, now: number) => {
    setOnceAt(value);
    setPickedAt(now);
  };
  const [custom, setCustom] = useState("0 9 * * *");
  const [timezone, setTimezone] = useState(browserTimezone());

  // Re-seed the form whenever the dialog opens on a different target.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name);
      setPrompt(editing.prompt);
      setKeepGate(true);
      setTimezone(editing.timezone);
      // Open in the plainest form that says exactly what is stored.
      const said = cronToHuman(editing.schedule);
      if (ONCE_SHAPE.test(editing.schedule)) {
        setMode("once");
        setOnceAt(editing.schedule.slice(0, 16));
      } else if (said) {
        setMode("words");
        setWords(said);
      } else {
        setMode("cron");
        setCustom(editing.schedule);
      }
    } else {
      setName("");
      setPrompt("");
      setMode("words");
      setWords("every day at 9");
      setOnceAt("");
      setCustom("0 9 * * *");
      setTimezone(browserTimezone());
    }
  }, [open, editing]);

  // Plain words: a repeating schedule, or a one-time phrase ("today at 9pm")
  // read against the date the user typed it on.
  const typedOn = new Date(pickedAt);
  const wordsOnce =
    mode === "words" && pickedAt
      ? humanToOnce(words, {
          year: typedOn.getFullYear(),
          month: typedOn.getMonth() + 1,
          day: typedOn.getDate(),
        })
      : null;
  const wordsOncePast =
    wordsOnce !== null && new Date(wordsOnce).getTime() <= pickedAt;
  const ruled =
    mode !== "words"
      ? null
      : wordsOnce
        ? wordsOncePast
          ? null
          : wordsOnce
        : humanToCron(words);
  // When the rules miss, a fast model reads the words, once the user
  // pauses typing. Its answer is shown in words before anything is saved.
  const [settledWords, setSettledWords] = useState<string | null>(null);
  useEffect(() => {
    if (mode !== "words" || ruled || wordsOncePast) return;
    const timer = setTimeout(() => setSettledWords(words.trim()), 600);
    return () => clearTimeout(timer);
  }, [mode, ruled, wordsOncePast, words]);
  const asking =
    mode === "words" &&
    !ruled &&
    !wordsOncePast &&
    settledWords === words.trim();
  const modelRead = useParseWords(
    agentId,
    asking ? settledWords : null,
    timezone.trim(),
  );
  const modelSchedule =
    asking && modelRead.data?.ok ? modelRead.data.schedule : null;
  const understood = ruled ?? modelSchedule;
  const schedule = (): string | null => {
    if (mode === "cron") return custom.trim() || null;
    if (mode === "once") {
      // datetime-local yields "YYYY-MM-DDTHH:mm"; croner wants full seconds.
      // A moment already past would never fire, so it is not a schedule.
      const value = onceAt.trim();
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
      if (new Date(value).getTime() <= pickedAt) return null;
      return `${value}:00`;
    }
    return understood;
  };
  const oncePast =
    mode === "once" && onceAt !== "" && new Date(onceAt).getTime() <= pickedAt;

  // A save holds the dialog (the server validates it); a delete is instant.
  const busy = create.isPending || update.isPending;
  // Saving needs a name, a task and a When it understood: both save buttons
  // share this.
  const canSave =
    name.trim() !== "" && prompt.trim() !== "" && schedule() !== null;
  const router = useRouter();
  const pathname = usePathname();
  // A double click (or Enter + click) must never save twice: the pending flag
  // only flips after the request is under way, this ref flips at once.
  const submitting = useRef(false);

  // Every write pairs a check with its words; a row from before that rule
  // falls back to the check itself.
  const condition = editing?.gateDescription ?? editing?.gate;

  const submit = (then?: (saved: { name: string }) => void) => {
    const expression = schedule();
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The FRAME is fixed and the fields scroll inside it: a schedule's
          prompt is a whole runbook in practice, and a dialog that grows with
          it would carry its own title and Save button off-screen — with
          nothing to scroll, since the dialog is positioned `fixed`. */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit schedule" : "New schedule"}
          </DialogTitle>
          <DialogDescription>
            The agent runs this on schedule and reports back to the chat the
            schedule was created from.
          </DialogDescription>
        </DialogHeader>

        {/* `-m-1 p-1` buys the scroll box a 4px gutter: a focus ring is a
            box-shadow, which adds nothing to scrollable overflow, so a ring on
            an edge field would otherwise be shaved off by `overflow-y-auto`. */}
        <DialogBody className="-m-1 space-y-4 p-1">
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

          <div className="space-y-1.5">
            <Label htmlFor="cron-when">{mode === "once" ? "On" : "When"}</Label>
            {mode === "words" && (
              <Input
                id="cron-when"
                value={words}
                onChange={(event) => {
                  setWords(event.target.value);
                  setPickedAt(event.timeStamp + performance.timeOrigin);
                }}
                placeholder="every 5 minutes, weekdays at 9…"
              />
            )}
            {mode === "once" && (
              <Input
                id="cron-when"
                type="datetime-local"
                min={pickedAt ? localMinute(new Date(pickedAt)) : undefined}
                value={onceAt}
                onChange={(event) =>
                  pickOnce(
                    event.target.value,
                    event.timeStamp + performance.timeOrigin,
                  )
                }
              />
            )}
            {mode === "cron" && (
              <Input
                id="cron-when"
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
                placeholder="0 14 * * 1-5"
                className="font-mono"
              />
            )}
            <div className="flex items-center justify-between gap-3 text-xs">
              <span
                className={
                  (mode === "words" &&
                    !understood &&
                    !(asking && modelRead.isFetching)) ||
                  oncePast
                    ? "text-destructive"
                    : "text-muted-foreground"
                }
              >
                {mode === "words"
                  ? understood
                    ? `✓ ${whenLabel(understood) ?? understood}`
                    : wordsOncePast
                      ? "That time has passed. Pick a later one."
                      : asking && modelRead.isFetching
                        ? "Reading that…"
                        : 'Not sure when. Try "every 5 minutes", "weekdays at 9" or "today at 9pm".'
                  : mode === "once"
                    ? oncePast
                      ? "That time has passed. Pick a later one."
                      : "Runs once, then completes."
                    : "Minute, hour, day, month, weekday."}
              </span>
              <span className="flex shrink-0 gap-3 text-muted-foreground">
                {(["words", "once", "cron"] as const)
                  .filter((other) => other !== mode)
                  .map((other) => (
                    <button
                      key={other}
                      type="button"
                      className="underline-offset-4 hover:text-foreground hover:underline"
                      onClick={(event) => {
                        const now = event.timeStamp + performance.timeOrigin;
                        // Carry what the user has into the other form.
                        const current = schedule();
                        if (other === "cron" && current && mode !== "once")
                          setCustom(current);
                        if (other === "words" && mode === "cron")
                          setWords(cronToHuman(custom) ?? words);
                        // Start a one-shot on the next whole hour, never
                        // a moment that has already passed.
                        if (other === "once" && !onceAt) {
                          const next = new Date(now);
                          next.setHours(next.getHours() + 1, 0, 0, 0);
                          pickOnce(localMinute(next), now);
                        }
                        setMode(other);
                      }}
                    >
                      {other === "words"
                        ? "Plain words"
                        : other === "once"
                          ? "Once"
                          : "Cron"}
                    </button>
                  ))}
              </span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cron-tz">Timezone</Label>
            <Input
              id="cron-tz"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              placeholder="America/Los_Angeles"
            />
          </div>

          {/* The run condition is the agent's to write: it knows the files
              and APIs, and a typed command that is missing or wrong fails
              every run. Here a person only sees it, and can turn it off. */}
          {editing?.gate ? (
            <div className="mt-2 mb-2 space-y-3 rounded-lg border bg-muted/40 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="cron-gated">Only run when</Label>
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
                      A free check runs first. Nothing new: skipped, no message.
                      Something new: the agent runs and reports. Check:{" "}
                      <code className="font-mono">{editing.gate}</code>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Switch
                  id="cron-gated"
                  checked={keepGate}
                  onCheckedChange={setKeepGate}
                />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm">
                <span className="truncate">{condition}</span>
                <AskAgentLink
                  agentId={agentId}
                  label="Change"
                  draft={`For the schedule "${editing.name}", change when it runs.\nNow it only runs when: ${condition}\nChange it to only run when: `}
                />
              </div>
            </div>
          ) : (
            <div className="mt-2 mb-2 space-y-3 rounded-lg border bg-muted/40 p-4">
              <div className="flex items-start gap-3">
                <Filter className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">Only run when needed</p>
                  <p className="text-xs text-muted-foreground">
                    Right now it runs every time. The agent can add a free check
                    so it only runs when something changed.
                  </p>
                </div>
              </div>
              {editing ? (
                // Same rule as Save: nothing to hand off while the form
                // has a When it doesn't understand.
                canSave ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    asChild
                  >
                    <Link
                      href={agentChatDraftPath(
                        pathname,
                        agentId,
                        setUpConditionDraft(editing.name),
                      )}
                    >
                      Set up with agent
                    </Link>
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    disabled
                  >
                    Set up with agent
                  </Button>
                )
              ) : (
                // A new schedule is saved first, so the agent edits a real
                // one (update_task) instead of creating a second.
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={canSave ? -1 : 0} className="block">
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
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
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-60">
                    {canSave
                      ? "Creates this schedule, then opens the chat so the agent can add the check."
                      : "Fill in the name, what it should do and when first."}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
        </DialogBody>

        <DialogFooter className="gap-2 sm:justify-between">
          {editing ? (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={busy}
              // Instant: the row leaves the list and the dialog closes on
              // click; the hook confirms, or puts the row back and says why.
              onClick={() => {
                remove.mutate(editing.id);
                onOpenChange(false);
              }}
            >
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={busy || !canSave}
              loading={create.isPending || update.isPending}
              onClick={() => submit()}
            >
              {editing ? "Save" : "Create"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
