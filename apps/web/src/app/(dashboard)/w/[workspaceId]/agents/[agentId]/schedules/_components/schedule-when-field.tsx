"use client";

import { useEffect, useState } from "react";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { useParseWords } from "@/hooks/use-crons";
import {
  cronToHuman,
  humanToCron,
  humanToOnce,
} from "@/lib/agents/human-schedule";
import { whenLabel } from "./schedule-grid";

/**
 * The "When" of any schedule (a task or the eval schedule): plain words
 * ("every 5 minutes", "weekdays at 9") read by a rule-based parser that
 * never guesses, with a fast model as the fallback; a one-shot date and a
 * raw cron expression are the two alternatives. What it understood is shown
 * under the field before anything is saved; the server (croner) stays the
 * validator.
 */

type Mode = "words" | "once" | "cron";

/** The one-shot form: an ISO 8601 local datetime (croner reads it as a
 * fire-once pattern in the schedule's timezone; no offset by design: the
 * timezone field governs). */
const ONCE_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

/** A Date as datetime-local's "YYYY-MM-DDTHH:mm", in the browser's zone. */
const localMinute = (date: Date): string => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

export interface ScheduleWhen {
  mode: Mode;
  words: string;
  onceAt: string;
  custom: string;
  /** "Now", taken when a time is picked (render stays pure). */
  pickedAt: number;
}

/** The form state for a saved expression, in the plainest mode that says
 * exactly what is stored, or the default for a new schedule. */
export const whenFrom = (saved: string | null): ScheduleWhen => {
  const base = {
    words: "every day at 9",
    onceAt: "",
    custom: "0 9 * * *",
    pickedAt: 0,
  };
  if (!saved) return { ...base, mode: "words" };
  if (ONCE_SHAPE.test(saved))
    return { ...base, mode: "once", onceAt: saved.slice(0, 16) };
  const said = cronToHuman(saved);
  if (said) return { ...base, mode: "words", words: said };
  return { ...base, mode: "cron", custom: saved };
};

/**
 * Read a When: the expression it means (null while it means nothing yet),
 * and the line to show under the field. A hook, because plain words the
 * rules miss are read by a model once the person pauses typing.
 */
export const useScheduleWhen = (
  agentId: string,
  when: ScheduleWhen,
  timezone: string,
) => {
  const { mode, words, onceAt, custom, pickedAt } = when;
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
  const oncePast =
    mode === "once" && onceAt !== "" && new Date(onceAt).getTime() <= pickedAt;

  const expression = ((): string | null => {
    if (mode === "cron") return custom.trim() || null;
    if (mode === "once") {
      // datetime-local yields "YYYY-MM-DDTHH:mm"; croner wants seconds. A
      // moment already past would never fire, so it is not a schedule.
      const value = onceAt.trim();
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
      if (new Date(value).getTime() <= pickedAt) return null;
      return `${value}:00`;
    }
    return understood;
  })();

  const reading = asking && modelRead.isFetching;
  const hint =
    mode === "words"
      ? understood
        ? `✓ ${whenLabel(understood) ?? understood}`
        : wordsOncePast
          ? "That time has passed. Pick a later one."
          : reading
            ? "Reading that…"
            : 'Not sure when. Try "every 5 minutes", "weekdays at 9" or "today at 9pm".'
      : mode === "once"
        ? oncePast
          ? "That time has passed. Pick a later one."
          : "Runs once, then completes."
        : "Minute, hour, day, month, weekday.";
  const hintIsError = (mode === "words" && !understood && !reading) || oncePast;

  return { expression, hint, hintIsError };
};

/** The When field: the input for the current mode, what it understood,
 * and the switch to the other two forms. */
export const ScheduleWhenField = ({
  id,
  when,
  onChange,
  hint,
  hintIsError,
  expression,
}: {
  id: string;
  when: ScheduleWhen;
  onChange: (next: ScheduleWhen) => void;
  hint: string;
  hintIsError: boolean;
  /** What the current form means, carried into the next form on a switch. */
  expression: string | null;
}) => {
  const { mode, words, onceAt, custom, pickedAt } = when;
  const set = (patch: Partial<ScheduleWhen>) => onChange({ ...when, ...patch });
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{mode === "once" ? "On" : "When"}</Label>
      {mode === "words" && (
        <Input
          id={id}
          value={words}
          onChange={(event) =>
            set({
              words: event.target.value,
              pickedAt: event.timeStamp + performance.timeOrigin,
            })
          }
          placeholder="every 5 minutes, weekdays at 9…"
        />
      )}
      {mode === "once" && (
        <Input
          id={id}
          type="datetime-local"
          min={pickedAt ? localMinute(new Date(pickedAt)) : undefined}
          value={onceAt}
          onChange={(event) =>
            set({
              onceAt: event.target.value,
              pickedAt: event.timeStamp + performance.timeOrigin,
            })
          }
        />
      )}
      {mode === "cron" && (
        <Input
          id={id}
          value={custom}
          onChange={(event) => set({ custom: event.target.value })}
          placeholder="0 14 * * 1-5"
          className="font-mono"
        />
      )}
      <div className="flex items-center justify-between gap-3 text-xs">
        <span
          className={hintIsError ? "text-destructive" : "text-muted-foreground"}
        >
          {hint}
        </span>
        <span className="flex shrink-0 gap-3 text-muted-foreground">
          {(["words", "once", "cron"] as const)
            .filter((other) => other !== mode)
            .map((other) => (
              <button
                key={other}
                type="button"
                className="hover:text-foreground focus-visible:ring-ring/50 rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2"
                onClick={(event) => {
                  const now = event.timeStamp + performance.timeOrigin;
                  const next: Partial<ScheduleWhen> = { mode: other };
                  // Carry what the person has into the other form.
                  if (other === "cron" && expression && mode !== "once")
                    next.custom = expression;
                  if (other === "words" && mode === "cron")
                    next.words = cronToHuman(custom) ?? words;
                  // Start a one-shot on the next whole hour, never a moment
                  // that has already passed.
                  if (other === "once" && !onceAt) {
                    const start = new Date(now);
                    start.setHours(start.getHours() + 1, 0, 0, 0);
                    next.onceAt = localMinute(start);
                    next.pickedAt = now;
                  }
                  set(next);
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
  );
};
