import { z } from "zod";

/**
 * Zod surfaces for the agent-cron routes and the schedule_task MCP tool
 * (step 7). The service imports the unions from here; the schemas are the
 * HTTP/tool shells around them.
 *
 * The schedule string is NOT validated structurally here — croner is the one
 * authority on what parses AND what advances, so the service validates by
 * constructing the same object it will later compute occurrences with. A
 * regex approximation would accept expressions the engine later rejects,
 * which is exactly the "exists but can never fire" row the model forbids.
 */

export const CRON_DISABLED_REASONS = [
  "authorization",
  "failures",
  // A one-shot (or otherwise exhausted) schedule that fired its last
  // occurrence — terminal by design, not broken.
  "completed",
] as const;
export type CronDisabledReason = (typeof CRON_DISABLED_REASONS)[number];

export const CRON_OUTCOMES = ["ok", "failed", "skipped_busy"] as const;
export type CronOutcome = (typeof CRON_OUTCOMES)[number];

/** Bounds shared by the dashboard routes and the MCP tool. */
export const CRON_NAME_MAX_LENGTH = 100;
export const CRON_PROMPT_MAX_LENGTH = 10_000;
export const CRON_SCHEDULE_MAX_LENGTH = 100;
export const CRON_TIMEZONE_MAX_LENGTH = 100;

const cronFields = {
  name: z.string().trim().min(1).max(CRON_NAME_MAX_LENGTH),
  prompt: z.string().trim().min(1).max(CRON_PROMPT_MAX_LENGTH),
  schedule: z.string().trim().min(1).max(CRON_SCHEDULE_MAX_LENGTH),
  timezone: z.string().trim().min(1).max(CRON_TIMEZONE_MAX_LENGTH),
};

/** POST /v1/agents/:agentId/crons */
export const createCronSchema = z.object(cronFields).strict();

/** PATCH /v1/agents/:agentId/crons/:cronId — partial; `enabled` is the pause
 * switch (re-enabling clears an auto-disable reason). */
export const updateCronSchema = z
  .object({
    ...Object.fromEntries(
      Object.entries(cronFields).map(([key, schema]) => [
        key,
        schema.optional(),
      ]),
    ),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "Nothing to update",
  });

/** The schedule_task tool's arguments — same shape as create; the timezone is
 * REQUIRED here too, deliberately: "14:00" means nothing without a zone, and
 * the capability fragment tells the agent to resolve it with the user. */
export const scheduleTaskArgsSchema = createCronSchema;

/** cancel_task */
export const cancelTaskArgsSchema = z
  .object({
    cronId: z.string().trim().min(1).max(100),
  })
  .strict();

/** list_tasks takes no arguments. */
export const listTasksArgsSchema = z.object({}).strict();
