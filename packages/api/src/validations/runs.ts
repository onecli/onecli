import { z } from "zod";

/**
 * Agent RUNS (the turn audit view): the list query surface, the response
 * shapes, and the bounds the service and the dashboard share. A LEAF module on
 * purpose (zod only), so the web client imports these types and the window
 * rule instead of hand-mirroring them, without pulling the service's database
 * client into a client bundle. Dates are ISO strings.
 */

/** Most turns a single list call returns. */
export const RUNS_PAGE_MAX = 100;

/**
 * Grace on either side of a turn's [start, finish] window when matching it to
 * gateway rows: the runner reports start and finish a beat after the sandbox
 * acts. The server pads evidence scans with it, and the dashboard pads the
 * window it opens a run's requests in with the same value, so the two never
 * disagree.
 */
export const RUN_WINDOW_SLACK_MS = 2_000;

/** `GET /v1/runs` and `GET /v1/agents/:agentId/runs`. */
export const runsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(RUNS_PAGE_MAX).optional(),
    // Cursor syntax (`<createdAt ISO>~<turn id>`) is validated in the service.
    before: z.string().min(1).max(200).optional(),
    source: z.string().min(1).max(40).optional(),
    userId: z.string().min(1).max(100).optional(),
    app: z.string().min(1).max(100).optional(),
    failed: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
  })
  .transform(({ failed, ...rest }) => ({ ...rest, failedOnly: failed }));
/** The parsed list query, as the service takes it (every field optional). */
export type RunsQuery = Partial<z.output<typeof runsQuerySchema>>;

/** Gateway evidence is a time-window correlation, never exact attribution. */
export type RunAppAttribution = "agent_time_window" | "withheld";

export interface RunToolCall {
  callId: string;
  name: string;
  input: string | null;
  output: string | null;
  isError: boolean;
}

export interface RunAppCall {
  provider: string;
  host: string;
  method: string;
  status: number;
  latencyMs: number;
  at: string;
}

/** What every run shows: who, where from, which agent, how it ended. */
interface RunFacts {
  turnId: string;
  conversationId: string;
  /** The agent that ran it: the workspace list spans agents. */
  agent: { id: string; name: string };
  source: string;
  direct: boolean;
  status: string;
  askedBy: { id: string; email: string; name: string | null } | null;
  appAttribution: RunAppAttribution;
  appsUsed: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

/** What the agent was asked and what it did: the conversation's content. */
interface RunContent {
  question: string;
  answer: string | null;
  error: string | null;
  toolNames: string[];
}

/**
 * One row of a runs list. A colleague's private thread (listed only to an org
 * admin, and only where roles are enforced) carries no content: reading it is
 * the audited detail read, never a side effect of browsing or polling a list.
 */
export type RunListItem =
  | (RunFacts & RunContent & { private: false })
  | (RunFacts & { private: true });

export interface RunDetail extends RunFacts, RunContent {
  tools: RunToolCall[];
  appCalls: RunAppCall[];
}

export interface RunsPage {
  runs: RunListItem[];
  /** Keyset cursor for the next page, or null on the last one. */
  nextBefore: string | null;
  /** The viewer holds the org-admin override (and sees app evidence). */
  isAdmin: boolean;
  appEvidenceWithheld: boolean;
}
