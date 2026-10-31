/**
 * PLATFORM JOBS: work the control plane starts on its own, not because a
 * person or a schedule asked. A job has a pass the runner poll runs on the
 * job's own interval, and, optionally, a RUN shape: the hidden agent turns
 * the pass starts, in conversations of the job's own source. Memory review
 * is the first job. A job that never needs the agent (a pass that only
 * reads and writes rows) simply declares no run shape.
 *
 * Every job run follows the same four rules, decided HERE rather than by a
 * per-source branch at each site that cares:
 *
 * 1. FRESH SESSION. A run never resumes its conversation's harness session
 *    and never leaves one behind (`claimDueWork`): each run is unrelated to
 *    the last, and carrying the previous transcript in would replay every
 *    earlier run at full price.
 * 2. NOT ENGAGEMENT. Nobody is waiting on a run, so it never restarts the
 *    sandbox's idle or background clocks (`createTurn`, `applyTurnEvents`,
 *    `applyTurnProgress`). The stop arm never parks a box with a turn in
 *    flight, so the run stays safe without holding a quiet box up.
 * 3. SEALED CONVERSATION. Only the job's pass opens a conversation on its
 *    source (`createConversation` refuses it to clients), that
 *    conversation takes the job's runs and nothing else, and the job's
 *    source is refused everywhere else (`requireConversationFor`). What
 *    lands there can decide the job's dueness, so a person (or another
 *    platform door) minting or writing into one could silence or forge the
 *    job.
 * 4. DELIVERY-ONLY CONTEXT. A run's dispatch context is the agent's memory
 *    index plus the job's own block (`buildTurnContext`), composed at
 *    dispatch and never stored: the run conversation is a group
 *    conversation, so anything private the job reads must not ride the
 *    stored message.
 *
 * Registration is explicit, at the composition root (`createApiApp`), never
 * a module-load side effect: a job whose module nothing happened to import
 * would silently never run. A deployment adds its own jobs the same way,
 * from an entry point bundled with the server so both share this one
 * registry. Before or after the server boots is equally fine: the poll and
 * every run rule read the registry live, nothing caches it.
 *
 * This module is a leaf on purpose (types, the registry and lookups, no
 * service imports): the dispatch claim, the turn doors and the context
 * builder all consult it, and a job's own module imports those, so any
 * import back from here would be a cycle.
 */

import type {
  AutomationSource,
  ConversationSource,
} from "../validations/conversation";

/** The hidden agent turns a job starts. */
export interface PlatformJobRuns {
  /**
   * The conversation and turn source of every run. Unique across jobs. A
   * stored conversation source, because the job's pass opens its runs
   * through the ordinary sourced-conversation and turn doors, and an
   * automation source, so every automation fence (ranked behind people,
   * never a schedule's anchor, never mirrored, never itself reviewed)
   * covers the runs with no edit of its own.
   */
  source: Extract<AutomationSource, ConversationSource>;
  /**
   * The job's own block of the run's dispatch context (rule 4), or null for
   * none. Composed at dispatch from current truth. `conversationId` is the
   * run's own conversation (its agent and external reference are on that
   * row) and `createdAt` is when the run's turn was born.
   */
  context: (run: {
    conversationId: string;
    createdAt: Date;
  }) => Promise<string | null>;
}

export interface PlatformJob {
  /** Unique. Names the job in logs. */
  name: string;
  /**
   * How often, at most, the poll runs `pass`, per api process. The poll is
   * the control plane's only tick, so this bounds the job's latency.
   */
  passIntervalMs: number;
  /**
   * Find what is due and act on it. Several api processes may run the same
   * pass at once, so a pass must be safe under concurrency (a claim, or the
   * one-active-turn index refusing the loser). A throw is logged and costs
   * this pass only: it never stops another job or dispatch.
   */
  pass: () => Promise<unknown>;
  /** Absent for a job that never starts an agent turn. */
  runs?: PlatformJobRuns;
}

const jobs = new Map<string, PlatformJob>();
const runsBySource = new Map<string, PlatformJobRuns>();

/**
 * Register a job. Idempotent for the same job object (every host calls
 * `createApiApp`, and tests call it once per app). A second job reusing a
 * name or a run source is a wiring bug and throws at boot, before anything
 * can fire under the wrong rules.
 */
export const registerPlatformJob = (job: PlatformJob): void => {
  const existing = jobs.get(job.name);
  if (existing === job) return;
  if (existing) {
    throw new Error(`platform job already registered: ${job.name}`);
  }
  if (!Number.isFinite(job.passIntervalMs) || job.passIntervalMs <= 0) {
    throw new Error(`platform job ${job.name}: passIntervalMs must be > 0`);
  }
  if (job.runs && runsBySource.has(job.runs.source)) {
    throw new Error(
      `platform job run source already registered: ${job.runs.source}`,
    );
  }
  jobs.set(job.name, job);
  if (job.runs) runsBySource.set(job.runs.source, job.runs);
};

/** Every registered job, in registration order (the poll's pass order). */
export const platformJobs = (): Iterable<PlatformJob> => jobs.values();

/** The run shape behind a turn or conversation source, or undefined when
 * the source is not a platform job's run. */
export const platformJobRunsOf = (
  source: string,
): PlatformJobRuns | undefined => runsBySource.get(source);

/** Whether this source is a platform job's run (rules 1 to 3 apply). */
export const isPlatformJobRun = (source: string): boolean =>
  runsBySource.has(source);
