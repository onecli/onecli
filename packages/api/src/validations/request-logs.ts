import { z } from "zod";

/**
 * Activity's Network tab (the gateway request log): the page query the
 * dashboard sends. A LEAF module (zod only) so the browser can import the
 * filter vocabulary without the request-log service's database client. Parsed
 * where the request crosses into the server, so a malformed cursor, agent id
 * or window bound is refused there instead of reaching the query.
 */

export const ACTIVITY_FILTERS = ["all", "hide-llm", "blocked"] as const;
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];

export const activityPageSchema = z.object({
  cursor: z
    .object({ createdAt: z.iso.datetime(), id: z.string().min(1).max(100) })
    .optional(),
  limit: z.number().int().min(1).max(200).optional(),
  filter: z.enum(ACTIVITY_FILTERS).optional(),
  /** Narrow to one agent (a run's requests, or an agent's activity). */
  agentId: z.string().min(1).max(100).optional(),
  /** A time window, both ends inclusive: a run's padded [start, finish]. */
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});
export type ActivityPageParams = z.input<typeof activityPageSchema>;

/** The Network tab's scope as it rides the URL: an agent and a time window. */
export const activityScopeSchema = activityPageSchema.pick({
  agentId: true,
  from: true,
  to: true,
});
