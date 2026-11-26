import { db, Prisma } from "@onecli/db";
import { turnUsageSchema } from "@onecli/agent-protocol";
import { logger } from "../lib/logger";
import { AUTOMATION_SOURCES, EVAL_SOURCE } from "../validations/conversation";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  recordServiceAuditEvent,
} from "./audit-service";
import {
  asContextSize,
  CONTEXT_FIT_COOLDOWN_MS,
  CONTEXT_FIT_LOOKBACK,
  decideContextSize,
  type ContextSize,
} from "./context-fit-rule";
import type { PlatformJob } from "./platform-jobs";

const log = logger.child({ component: "context-fit" });

/**
 * CONTEXT FIT: the platform picks each conversation's context size by
 * itself, from that conversation's own recent turns. Nobody asks for it:
 * not the person, not the agent. A long working thread that keeps filling
 * its context grows; a short one shrinks; most stay at the default.
 *
 * A platform job with NO run shape (platform-jobs: "a job that never needs
 * the agent"): the pass reads finished turns, applies the pure rule
 * (`context-fit-rule.ts`) and writes the answer onto the conversation. It
 * never starts a turn, wakes a box, or spends a model call. The size reaches
 * the harness with the conversation's next turn (the dispatch reads it) and
 * applies to that conversation's session alone.
 *
 * Dueness: a conversation is looked at once per finished turn (a turn that
 * finished since the job last looked at it) once its cooldown has passed;
 * the rule then needs enough turns since its last change to move at all.
 * Automation, pair and eval conversations are left alone: a
 * platform-started run is short and unrelated to the next, and an eval is
 * a test question.
 *
 * Concurrency: two api processes may run the pass at once. The write is
 * conditional on the size and change time it decided from, so the loser
 * changes nothing (and audits nothing).
 */

/** Conversations decided per pass: the pass runs every 30 s, and a
 * conversation only needs deciding after it has had new turns. */
const CONTEXT_FIT_LIMIT = 50;

/** Only conversations with a finished turn this recent are looked at: a
 * conversation nobody is using has no next turn to carry a new size. */
const CONTEXT_FIT_ACTIVE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** The service actor its audit rows name. */
export const CONTEXT_FIT_ACTOR = "context-fit";

export interface CandidateRow {
  conversation_id: string;
  workspace_id: string;
  organization_id: string;
  context_tokens: number | null;
  context_tokens_changed_at: Date | null;
  /** The newest finished turn this look covers: the stamp it leaves. */
  last_finished_at: Date;
}

interface UsageRow {
  usage: Prisma.JsonValue;
}

/** Conversations worth deciding now: out of cooldown, with a turn that
 * finished after the job last looked (or ever, if it never looked), in the
 * active window. Each conversation is read at most once per finished turn:
 * every look stamps `context_fit_checked_at`, so an idle conversation costs
 * nothing on the next pass.
 *
 * Driven from the window's finished turns, not from every conversation, so
 * a pass costs what the last hours held, never the whole history: the
 * `updated_at` bound rides the `turns(status, updated_at)` index (a turn's
 * `updated_at` is stamped with, and never before, its `finished_at`). The
 * longest-waiting conversation goes first, so none starves behind busier
 * ones when a pass has more candidates than its limit. */
const findCandidates = async (now: Date): Promise<CandidateRow[]> => {
  const activeSince = new Date(now.getTime() - CONTEXT_FIT_ACTIVE_WINDOW_MS);
  const cooledBefore = new Date(now.getTime() - CONTEXT_FIT_COOLDOWN_MS);
  const skipped = Prisma.join([...AUTOMATION_SOURCES, "agent", EVAL_SOURCE]);
  return db.$queryRaw<CandidateRow[]>`
    WITH recent AS (
      SELECT t.conversation_id, max(t.finished_at) AS last_finished_at
      FROM turns t
      WHERE t.status = 'done'
        AND t.updated_at > ${activeSince}
        AND t.finished_at > ${activeSince}
        AND t.usage->>'promptTokens' IS NOT NULL
      GROUP BY t.conversation_id
    )
    SELECT c.id AS conversation_id, a.workspace_id, w.organization_id,
           c.context_tokens, c.context_tokens_changed_at,
           recent.last_finished_at
    FROM recent
    JOIN conversations c ON c.id = recent.conversation_id
    JOIN agents a ON a.id = c.agent_id
    JOIN workspaces w ON w.id = a.workspace_id
    WHERE a.kind = 'hosted'
      AND c.source NOT IN (${skipped})
      AND (c.context_tokens_changed_at IS NULL
           OR c.context_tokens_changed_at < ${cooledBefore})
      AND (c.context_fit_checked_at IS NULL
           OR recent.last_finished_at > c.context_fit_checked_at)
    ORDER BY recent.last_finished_at ASC
    LIMIT ${CONTEXT_FIT_LIMIT}
  `;
};

/** How full each of the conversation's newest measured turns was, newest
 * first (in the order the turns were sent, which the
 * `turns(conversation_id, created_at)` index serves, so a long
 * conversation costs a bounded read), counting only turns CREATED after its
 * last change: a turn that was already running when the size changed ran
 * at the old size, so it is no evidence about the new one.
 *
 * A turn is evidence only when its harness measured the prompt
 * (`promptTokens`, normalized for the provider's cache accounting). One
 * without it (another harness, a provider the adapter does not know, a turn
 * from before the field) is no evidence at all: the raw counters add up
 * differently per provider, and a wrong sum would grow a conversation that
 * never needed it. */
const recentFillOf = async (row: CandidateRow): Promise<number[]> => {
  const turns = await db.$queryRaw<UsageRow[]>`
    SELECT t.usage
    FROM turns t
    WHERE t.conversation_id = ${row.conversation_id}
      AND t.status = 'done'
      AND t.usage->>'promptTokens' IS NOT NULL
      AND (${row.context_tokens_changed_at}::timestamp IS NULL
           OR t.created_at > ${row.context_tokens_changed_at})
    ORDER BY t.created_at DESC
    LIMIT ${CONTEXT_FIT_LOOKBACK}
  `;
  return turns.flatMap((turn) => {
    const parsed = turnUsageSchema.safeParse(turn.usage);
    return parsed.success && parsed.data.promptTokens !== undefined
      ? [parsed.data.promptTokens]
      : [];
  });
};

/** Write the new size if nobody changed it since `row` was read; audit only
 * a write that landed. Returns whether it did. Exported for the pg suite,
 * which drives the stale-read race deterministically. */
export const applySize = async (
  row: CandidateRow,
  from: ContextSize | null,
  to: ContextSize,
  now: Date,
): Promise<boolean> =>
  db.$transaction(async (tx) => {
    const { count } = await tx.conversation.updateMany({
      where: {
        id: row.conversation_id,
        contextTokens: row.context_tokens,
        contextTokensChangedAt: row.context_tokens_changed_at,
      },
      data: {
        contextTokens: to,
        contextTokensChangedAt: now,
        contextFitCheckedAt: row.last_finished_at,
      },
    });
    if (count === 0) return false;
    await recordServiceAuditEvent(tx, {
      workspaceId: row.workspace_id,
      organizationId: row.organization_id,
      serviceActor: CONTEXT_FIT_ACTOR,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.CONVERSATION,
      metadata: {
        conversationId: row.conversation_id,
        contextTokens: to,
        previousContextTokens: from,
      },
    });
    return true;
  });

/** Record that the job looked at this conversation through its newest
 * finished turn and kept its size, so the next pass skips it until a later
 * turn finishes. The stamp is that turn's own finish time, not the job's
 * clock, so the job's clock can never hide a turn; a turn stamped earlier
 * by a skewed writer at worst waits for the next finished turn, whose look
 * re-reads every turn as evidence. Forward-only, so a slower racing pass
 * never rewinds it. */
const markChecked = (row: CandidateRow) =>
  db.conversation.updateMany({
    where: {
      id: row.conversation_id,
      OR: [
        { contextFitCheckedAt: null },
        { contextFitCheckedAt: { lt: row.last_finished_at } },
      ],
    },
    data: { contextFitCheckedAt: row.last_finished_at },
  });

/**
 * Decide every candidate once. The job's pass, best-effort per
 * conversation: one bad row never stops the rest. Returns how many sizes
 * changed.
 */
export const fitContextSizes = async (now = new Date()): Promise<number> => {
  const candidates = await findCandidates(now);
  let changed = 0;
  for (const row of candidates) {
    try {
      const current = asContextSize(row.context_tokens);
      const next = decideContextSize({
        current,
        changedAt: row.context_tokens_changed_at,
        recentFill: await recentFillOf(row),
        now,
      });
      if (next === null) {
        await markChecked(row);
        continue;
      }
      if (await applySize(row, current, next, now)) {
        changed += 1;
        log.info(
          {
            conversationId: row.conversation_id,
            from: current,
            to: next,
          },
          "context size changed",
        );
      }
    } catch (err) {
      log.warn(
        { err, conversationId: row.conversation_id },
        "context fit failed for a conversation",
      );
    }
  }
  return changed;
};

/** Context fit as a platform job: a pass every 30 s per api process (a
 * size only needs revisiting after new turns), no agent runs. */
export const contextFitJob: PlatformJob = {
  name: "context-fit",
  passIntervalMs: 30 * 1000,
  pass: () => fitContextSizes(),
};
