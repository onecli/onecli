import { z } from "zod";
import { db } from "@onecli/db";
import { ServiceError } from "./errors";
import { askFastModel } from "./judges/fast-model";
import { resolveLlmCallKey } from "./llm-direct-call";
import { isFiveFieldSchedule, nextFireOrNull } from "./agent-cron-service";
import { isValidTimezone } from "../validations/timezone";

/**
 * The schedule dialog's fallback for "When" text its rule-based parser
 * (web `human-schedule.ts`) did not understand: one short call to a fast
 * model on the agent's own key turns the words into a schedule. The answer
 * is checked by the same croner law the schedules themselves use, so a
 * reply that never fires (or is not a schedule at all) reads "not
 * understood", never something else saved. The dialog shows the result in
 * words before anything is saved.
 */

const PARSE_TIMEOUT_MS = 8_000;
const MAX_TEXT = 200;

export type ScheduleParse =
  | { ok: true; schedule: string }
  | { ok: false; reason: "not-understood" | "no-model-key" };

const answerSchema = z.object({ schedule: z.string().max(100).nullable() });

const prompt = (text: string, timezone: string, now: string) =>
  `Turn a schedule written in plain words into ONE schedule string.
Now is ${now} in ${timezone}; read every time in that timezone.
- Repeating: a 5-field cron expression (minute hour day-of-month month day-of-week), e.g. "0 9 * * 1-5".
- Once: a local datetime "YYYY-MM-DDTHH:mm:00" in the future, e.g. "2026-11-02T15:00:00".
- Anything that is not a schedule, or cannot be one cron line: null.
Answer only JSON: {"schedule": "..."} or {"schedule": null}.

Words: ${JSON.stringify(text)}`;

/** The JSON object inside a model reply, tolerating a code fence. */
const jsonOf = (reply: string): unknown => {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end < start) return null;
  try {
    return JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
};

export const parseScheduleWords = async (
  workspaceId: string,
  organizationId: string,
  agentId: string,
  input: { text: string; timezone: string },
): Promise<ScheduleParse> => {
  const text = input.text.trim().slice(0, MAX_TEXT);
  if (!text) return { ok: false, reason: "not-understood" };
  if (!isValidTimezone(input.timezone)) {
    throw new ServiceError("BAD_REQUEST", "Unknown timezone");
  }
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: { id: true, workspaceId: true },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");

  const resolved = await resolveLlmCallKey(agent, organizationId);
  if (!resolved.ok) return { ok: false, reason: "no-model-key" };

  const now = new Date();
  const local = now.toLocaleString("sv-SE", { timeZone: input.timezone });
  try {
    const reply = await askFastModel(resolved.key, {
      prompt: prompt(text, input.timezone, local),
      maxTokens: 60,
      signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
    });
    const answer = answerSchema.safeParse(jsonOf(reply));
    const schedule = answer.success ? answer.data.schedule?.trim() : null;
    // Only what the save door would accept and what actually fires is a
    // schedule: a model that answers with a seconds field must not reach a
    // Save button the server then refuses.
    if (
      !schedule ||
      !isFiveFieldSchedule(schedule) ||
      !nextFireOrNull(schedule, input.timezone, now)
    ) {
      return { ok: false, reason: "not-understood" };
    }
    return { ok: true, schedule };
  } catch {
    // A slow, refused or failed call reads as not understood: the dialog
    // still offers Once and Cron.
    return { ok: false, reason: "not-understood" };
  }
};
