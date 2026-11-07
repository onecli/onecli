import { z } from "zod";

/**
 * RUNTIME USAGE (awake time): the query surface and response shapes of
 * `GET /v1/agents/:agentId/usage` and `GET /v1/usage/runtime`. A LEAF module
 * on purpose (zod only), so the web client imports the types instead of
 * hand-mirroring them, without pulling the service into a client bundle.
 * Durations are whole seconds.
 */

const utcDayStart = (date: string) => new Date(`${date}T00:00:00.000Z`);

/**
 * `?from&to` as UTC DATES (YYYY-MM-DD), both optional: `from` is that day's
 * start (default: all time), `to` is that day's END, clamped to now
 * (default: now). Whole days, because the reads answer whole days from the
 * daily rollup and only today from the ledger: a window edge inside a past
 * day would need the ledger for that day too, and a ledger read over an
 * arbitrary past day cannot be bounded (a run's length is not).
 */
export const usageWindowSchema = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  })
  .transform(({ from, to }) => {
    const now = new Date();
    const toEnd = to ? new Date(utcDayStart(to).getTime() + 86_400_000) : now;
    return {
      from: from ? utcDayStart(from) : new Date(0),
      to: toEnd > now ? now : toEnd,
    };
  })
  .refine(({ from, to }) => from < to, { message: "from must precede to" });

export type UsageWindow = z.output<typeof usageWindowSchema>;

/** One agent's awake seconds inside the window. */
export interface AgentAwakeTime {
  agentId: string;
  awakeSeconds: number;
}

/** `GET /v1/agents/:agentId/usage`: one agent over a window. */
export interface AgentRuntimeUsage extends AgentAwakeTime {
  from: string;
  to: string;
  /** Whether the agent's sandbox is up as of this read. */
  running: boolean;
}

/** `GET /v1/usage/runtime`: the org's agents over a window. */
export interface OrgRuntimeUsage {
  from: string;
  to: string;
  /** Every agent with awake time in the window, most first; zero rows are
   * omitted, and an agent since deleted is still listed by its id. */
  agents: AgentAwakeTime[];
  /** The sum over `agents`. */
  awakeSeconds: number;
}
