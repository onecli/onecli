import { db, Prisma } from "@onecli/db";
import { runnerCapabilitiesSchema } from "@onecli/agent-protocol";
import {
  MAX_HELD_AWAKE_SANDBOXES,
  SANDBOX_IDLE_STOP_SECONDS,
  SSH_SESSION_LEASE_SECONDS,
  TURN_CEILING_SECONDS,
  TURN_CEILING_WARNING_SECONDS,
  TURN_STALL_SECONDS,
} from "../lib/env";
import {
  ACTIVE_TURN_STATUSES,
  AGENT_NEVER_STARTED_MESSAGE,
  AUTOMATION_SOURCES,
  FOLLOW_UP_EXPIRED_MESSAGE,
  TURN_CEILING_WARNING_MESSAGE,
  TURN_STALLED_MESSAGE,
  TURN_TIME_LIMIT_MESSAGE,
} from "../validations/conversation";
import { logger } from "../lib/logger";

const log = logger.child({ component: "due-work" });

/**
 * THE DISPATCH SEAM (plans/hosted-agents-v2.md §3.17, invariant 15).
 *
 * Every "what is due" query lives here and nowhere else. There is no
 * background loop in the control plane (§3.3): due work is computed at poll
 * time from Postgres, and claims use `FOR UPDATE SKIP LOCKED` so concurrent
 * pollers never hand the same sandbox to two runners. Scaling this — indexes,
 * priorities, per-runner sharding — happens inside this module; nothing
 * outside it may compute dueness or claim work.
 *
 * The wait-for-work signal is the seam's other half: v2 wakes a held poll
 * through an in-process emitter, and `LISTEN/NOTIFY` or Redis pub/sub swaps
 * in here when runner counts demand it.
 */

/** A claim older than this was made by a runner that died mid-work. */
const STALE_CLAIM_SECONDS = 300;

/**
 * A LEASE-CURRENT SSH session (sandbox-platform step 5): the terminator
 * heartbeats every ~30s, so a session whose `last_heartbeat_at` is inside
 * the lease window is a human at a live prompt — and one whose terminator
 * crashed goes silent and self-expires here without any cleanup write (the
 * poll-time-truth rule; the stale-session sweep closes the row for audit's
 * sake, but no consumer waits for it). `s` must be the enclosing query's
 * sandboxes alias. A function for the same mocked-db reason as
 * `keepAwakeExists`.
 */
const liveSshSessionExists = () => Prisma.sql`EXISTS (
  SELECT 1 FROM ssh_session ss
  WHERE ss.sandbox_id = s.id
    AND ss.status = 'open'
    AND ss.last_heartbeat_at > now() - make_interval(secs => ${SSH_SESSION_LEASE_SECONDS})
)`;

/**
 * §3.9 KEEP-AWAKE, as one SQL fragment with one definition — the stops arm
 * negates it, the ceiling counts it, the eviction arm requires it, and the
 * dashboard signal joins on it (so a live SSH session lights the dashboard's
 * "working in the background" badge too — accepted: one definition beats a
 * split predicate, and a held-open box IS busy from a capacity standpoint).
 * Three live shapes hold a box up: a lease-current SSH session, plus a running
 * process whose container_ref matches the sandbox's CURRENT one (a running
 * row from a DEAD container must never keep a fresh box awake — the lost
 * sweep terminalizes it), and a watch that is armed (detection lives in
 * supervisor memory) or triggered (its fire is owed). `s` must be the
 * enclosing query's sandboxes alias.
 *
 * A function, not a module-level const, so unit lanes with a mocked
 * `@onecli/db` (whose `Prisma` carries no `sql`) can import this module
 * without ever touching the real tagged-template helper.
 */
const keepAwakeExists = () => Prisma.sql`(EXISTS (
  SELECT 1 FROM sandbox_processes p
  WHERE p.sandbox_id = s.id
    AND (
      (p.status = 'running' AND p.container_ref = s.container_ref)
      OR EXISTS (
        SELECT 1 FROM process_watches w
        WHERE w.process_id = p.id
          AND w.status IN ('armed', 'triggered')
      )
    )
) OR ${liveSshSessionExists()})`;

/**
 * The per-runner held-awake ceiling (step 13, the release-blocker bound):
 * the operator env when set, else `max(1, maxSandboxes − 1)` — one slot is
 * always left for interactive turns, and there is no unlimited state. The
 * floor of 1 means a RUNNER_MAX_SANDBOXES=1 host can still be fully held:
 * that operator chose a single slot, and disabling keep-awake entirely there
 * would be the worse default.
 */
export const heldAwakeCeilingFor = (capabilities: unknown): number => {
  if (MAX_HELD_AWAKE_SANDBOXES !== null) return MAX_HELD_AWAKE_SANDBOXES;
  const parsed = runnerCapabilitiesSchema.safeParse(capabilities);
  const maxSandboxes = parsed.success ? parsed.data.maxSandboxes : 0;
  return Math.max(1, maxSandboxes - 1);
};

/**
 * How long a turn may sit `dispatched` before it is handed out again.
 *
 * Much shorter than the sandbox claim window, because `dispatched` is a
 * narrow state: the runner writes the turn to a live socket and the harness
 * emits `turn.started` at once, which moves it to `running`. Still sitting
 * here a minute later means it went into a socket that died on the way — a
 * real race while a sandbox is reconnecting — and the turn is simply lost
 * until someone re-dispatches it. Sharing the 5-minute sandbox window made
 * that a five-minute silence for the user; a `running` turn is unaffected,
 * so a slow model is never interrupted by this.
 */
const STALE_DISPATCH_SECONDS = 90;

/**
 * How long a sandbox that FAILED to start waits before it is tried again.
 * The poll returns as soon as anything is due, so without this a sandbox that
 * cannot start is re-claimed continuously rather than periodically.
 */
const START_RETRY_SECONDS = 30;

/**
 * WAKE PRIORITY (step 4): under a wake storm — the 9:00 cron cohort — a
 * person's message must not queue behind dozens of scheduled runs, so the
 * start and turn arms rank user-visible work first. "User-visible" is a
 * turn whose source is not an automation (`AUTOMATION_SOURCES` — the
 * one-edit law; a future automation source must inherit background rank by
 * that single edit), AGE-CAPPED: a background turn that has already waited
 * this long ranks as user-visible, so sustained user load delays automations
 * but can never starve them. (Unbounded, the only exit was the turn ceiling —
 * whose sweep now returns what it killed so the poll settles the automation's
 * bookkeeping through `settleSweptTurns`.) Measured on the ceiling clock
 * family (retried → promoted → created), the same one-way clocks
 * `reclaimStaleTurns` uses.
 */
export const WAKE_PRIORITY_AGE_SECONDS = 600;

/**
 * A turn that outranks background work: user-visible by source, or a
 * background turn past the age cap. `t` must be the enclosing query's turns
 * alias. A function, not a const, for the same mocked-db reason as
 * `keepAwakeExists`.
 */
const userVisibleTurn = (priorityAgeBefore: Date) => Prisma.sql`(
  t.source NOT IN (${Prisma.join([...AUTOMATION_SOURCES])})
  OR COALESCE(t.retried_at, t.promoted_at, t.created_at) < ${priorityAgeBefore}
)`;

export interface DueStart {
  kind: "start";
  sandboxId: string;
  agentId: string;
}

export interface DueStop {
  kind: "stop";
  sandboxId: string;
  containerRef: string | null;
}

/** A turn ready to run: its sandbox is up and nothing else is in flight. */
export interface DueTurn {
  kind: "turn";
  turnId: string;
  conversationId: string;
  sandboxId: string;
  /** The owning agent — what the dispatch-time context builder (step 8)
   * keys its memory reads on. */
  agentId: string;
  message: string;
  resumeSessionRef: string | null;
  /**
   * When this turn's claim-latency clock started — the same
   * COALESCE(retried_at, promoted_at, created_at) the turn-budget sweeps
   * use. Server-side telemetry only (the claim-wait log line → the cloud's
   * metric filter); never on the runner wire. Optional so test fakes that
   * predate it stay valid.
   */
  waitedSince?: Date;
}

/** Someone asked an in-flight turn to stop. */
export interface DueTurnAbort {
  kind: "turn.abort";
  turnId: string;
  conversationId: string;
  sandboxId: string;
}

/** A mid-run follow-up ready to steer into its target's live run. */
export interface DueTurnMessage {
  kind: "turn.message";
  /** The follow-up row's own id — the outcome's correlation key. */
  turnId: string;
  targetTurnId: string;
  conversationId: string;
  sandboxId: string;
  message: string;
}

/** A RUNNING sandbox whose home projection is behind desired (step 9). */
export interface DueHomeSync {
  kind: "home.sync";
  sandboxId: string;
  agentId: string;
  /** Desired at claim time — the generation the supervisor's ack will carry. */
  generation: number;
}

export type DueWork =
  | DueStart
  | DueStop
  | DueTurn
  | DueTurnAbort
  | DueTurnMessage
  | DueHomeSync;

interface ClaimedRow {
  id: string;
  agent_id: string;
  container_ref: string | null;
}

interface ClaimedTurnRow {
  id: string;
  conversation_id: string;
  /** From a correlated subquery — typed honestly, filtered at the mapping. */
  sandbox_id: string | null;
  /** Same shape as sandbox_id: correlated, nullable in principle only. */
  agent_id: string | null;
  message: string;
  harness_session_ref: string | null;
  waited_since: Date;
}

interface AbortRow {
  id: string;
  conversation_id: string;
  /** From a correlated subquery — typed honestly, filtered at the mapping. */
  sandbox_id: string | null;
}

/**
 * A turn a sweep just failed, with the copy it was failed under — returned
 * so the CALLER can settle automation bookkeeping (`settleSweptTurns`,
 * turn-service). The pairing lives at the poll rather than in here because
 * turn-service already imports this module (`signalWork`); the settle
 * import in this direction would be a cycle.
 */
export interface SweptTurn {
  turnId: string;
  conversationId: string;
  error: string;
  errorCode: "agent_start_failed" | "turn_time_limit" | "turn_stalled";
}

interface SweptTurnRow {
  id: string;
  conversation_id: string;
  never_started: boolean;
}

interface SteerRow {
  id: string;
  conversation_id: string;
  follow_up_of_turn_id: string;
  /** From a correlated subquery — typed honestly, filtered at the mapping. */
  sandbox_id: string | null;
  message: string;
}

interface SyncRow {
  id: string;
  agent_id: string;
  home_desired_generation: number;
}

/**
 * Turns get their OWN budget rather than sharing the lifecycle limit. A busy
 * conversation must never starve sandbox starts and stops — the two kinds of
 * work compete for a runner's attention but not for the same slots.
 */
const TURN_LIMIT = 5;

/**
 * The claim-wait log line's contract with the cloud's CloudWatch metric
 * filter (step 6): the filter pattern is built from EXACTLY these two
 * strings and byte-pinned by an infra drift test that reads this file — a
 * rename here without the infra edit would silently kill the TurnQueueSeconds
 * metric and its alarm (NOT_BREACHING = nobody would ever know).
 */
export const WORK_CLAIMED_LOG_MSG = "work claimed";
export const WORK_CLAIMED_WAIT_FIELD = "waitedSeconds";

/** Home syncs' own budget (the TURN_LIMIT reasoning), and the pacing
 * window on a claimed-but-unacked sync: `home_sync_claimed_at` is this
 * arm's WHOLE recovery clock — a claim lost anywhere (runner death, dropped
 * frame, old supervisor image, compose failure) re-arms after the window
 * with zero lost content, because generation content is read fresh at
 * compose. Deliberately not `updated_at`: that is the start/stop arms' stale
 * clock, and clocks stay single-purpose. */
const HOME_SYNC_LIMIT = 3;
export const HOME_SYNC_RETRY_SECONDS = 60;

/**
 * Claim up to `limit` due items for one runner, atomically.
 *
 * Due-to-start: never provisioned, or a claim that went stale because the
 * claiming runner died (`starting`/`stopping` older than STALE_CLAIM_SECONDS).
 * Due-to-stop: running past its idle window (§3.9 — sleep is the default).
 *
 * Both arms are fenced by `runner_id`: a sandbox lives on the runner that
 * created it, so runner B can never claim runner A's work (§3.17 — moot with
 * one runner, load-bearing the moment a second appears).
 */
export const claimDueWork = async (
  runnerId: string,
  limit: number,
): Promise<DueWork[]> => {
  const staleBefore = new Date(Date.now() - STALE_CLAIM_SECONDS * 1000);
  const staleDispatch = new Date(Date.now() - STALE_DISPATCH_SECONDS * 1000);
  const retryBefore = new Date(Date.now() - START_RETRY_SECONDS * 1000);
  const idleBefore = new Date(Date.now() - SANDBOX_IDLE_STOP_SECONDS * 1000);
  const syncRetryBefore = new Date(Date.now() - HOME_SYNC_RETRY_SECONDS * 1000);
  const priorityAgeBefore = new Date(
    Date.now() - WAKE_PRIORITY_AGE_SECONDS * 1000,
  );

  return db.$transaction(async (tx) => {
    // The claim is a CTE, deliberately — NOT `WHERE id IN (SELECT … LIMIT n
    // FOR UPDATE SKIP LOCKED)`. That form looks equivalent and is not: the
    // locking clause makes the subplan un-hashable, so Postgres re-runs it per
    // candidate row, each run claims a different set, and the union quietly
    // exceeds the limit — a runner asking for 5 gets handed everything due and
    // blows past its concurrency cap. The CTE is evaluated once. (Caught by
    // due-work.pg.test.ts's limit proof, which failed ~50% of runs.)
    const starts = await tx.$queryRaw<ClaimedRow[]>`
      WITH claimed AS (
        SELECT s.id FROM sandboxes s
        WHERE s.runner_id = ${runnerId}
          AND (
            s.status = 'unprovisioned'
            OR (s.status IN ('starting', 'stopping') AND s.updated_at < ${staleBefore})
            -- A PARKED SANDBOX WITH WORK STILL OWED.
            --
            -- createTurn wakes a stopped sandbox when the message arrives,
            -- but that only helps if it was already stopped: a sandbox that
            -- stops AFTERWARDS — the runner restarts, reconcile finds the
            -- channel gone — strands every turn already outstanding against
            -- it. The start arm would not claim it (it is not unprovisioned)
            -- and the turn arm would not claim the turn (its sandbox is not
            -- running), so the conversation waited for some unrelated message
            -- to happen along and wake it. Observed live, twice: 8 minutes
            -- with a queued turn, then 386 seconds with a dispatched one.
            --
            -- The condition is the WHOLE active set, not just queued. A turn
            -- that was handed to a sandbox which then died is dispatched, not
            -- queued, and it is exactly as stranded — matching only queued
            -- fixed the first deadlock and left its twin in place.
            --
            -- Deriving dueness from the queue makes that wake a latency
            -- optimization rather than the only path, which is the rule
            -- everywhere else here: Postgres is the truth, recomputed at
            -- poll time.
            OR (
              s.status IN ('stopped', 'failed')
              -- BACKOFF, and only on the failure path. A stopped sandbox is a
              -- parked one and must wake the instant a message arrives, so it
              -- is claimed immediately. A failed one is a start that just did
              -- not work, and re-claiming it on the very next poll is an
              -- unbounded hot loop: the poll returns the moment work exists,
              -- so a sandbox that cannot start (the runner at capacity, an
              -- image pull failure, a dead daemon) is retried as fast as two
              -- HTTP round trips allow, for the whole turn ceiling. The claim
              -- stamps updated_at, so this term is what paces the retry.
              AND (s.status = 'stopped' OR s.updated_at < ${retryBefore})
              -- Work still owed is a deliverable turn OR a lease-current SSH
              -- session (step 5's wake-on-connect, the same poll-time-truth
              -- rule: session-open's flip is the latency optimization, this
              -- arm is the wake that always happens). Deliberately INSIDE
              -- the backoff frame above — a sibling OR would bypass the
              -- failed-status pacing and reproduce the claim→refuse hot
              -- loop on a sandbox that cannot compose (parkUnstartableClaim).
              AND (
                EXISTS (
                  SELECT 1 FROM conversations c
                  JOIN turns t ON t.conversation_id = c.id
                  WHERE c.agent_id = s.agent_id
                    -- Only what the turn arm can actually deliver once the
                    -- sandbox is back. A running turn is unresumable, since
                    -- every start recreates the container, and it is failed
                    -- outright when the sandbox goes down (applyRunnerEvent) --
                    -- so waking for one would start a container to do nothing.
                    AND t.status IN ('queued', 'dispatched')
                )
                OR ${liveSshSessionExists()}
              )
            )
          )
        -- WAKE PRIORITY: a sandbox someone is waiting on outranks one only
        -- an automation woke (see WAKE_PRIORITY_AGE_SECONDS — the age cap
        -- keeps starvation bounded). Under a claim LIMIT the ORDER BY is the
        -- admission policy, exactly like the stop arm's LRU. A lease-current
        -- SSH session is user-visible by definition — a human is sitting at
        -- the prompt waiting for the boot.
        ORDER BY
          CASE WHEN EXISTS (
            SELECT 1 FROM conversations c
            JOIN turns t ON t.conversation_id = c.id
            WHERE c.agent_id = s.agent_id
              AND t.status IN ('queued', 'dispatched')
              AND ${userVisibleTurn(priorityAgeBefore)}
          ) OR ${liveSshSessionExists()} THEN 0 ELSE 1 END,
          s.updated_at ASC
        LIMIT ${limit}
        FOR UPDATE OF s SKIP LOCKED
      )
      UPDATE sandboxes s SET status = 'starting', updated_at = now(),
        -- Boot = first sync (step 9): every start begins with applied 0, so
        -- the sync arm fires the FULL set right after supervisor.ready. The
        -- claim is the one atomic gate every start path crosses; compose can
        -- fail/release after it, and a later re-claim re-resets — idempotent.
        home_applied_generation = 0,
        home_sync_claimed_at = NULL
      FROM claimed c
      WHERE s.id = c.id
      RETURNING s.id, s.agent_id, s.container_ref
    `;

    const remaining = limit - starts.length;
    const stops =
      remaining > 0
        ? await tx.$queryRaw<ClaimedRow[]>`
            WITH claimed AS (
              SELECT s.id FROM sandboxes s
              WHERE s.runner_id = ${runnerId}
                AND s.status = 'running'
                AND s.last_active_at IS NOT NULL
                AND s.last_active_at < ${idleBefore}
                -- Never park a sandbox with work in flight. The idle column
                -- alone is not enough: a model that thinks in silence for
                -- longer than the idle window would have its container pulled
                -- out from under it mid-answer.
                AND NOT EXISTS (
                  SELECT 1 FROM conversations c
                  JOIN turns t ON t.conversation_id = c.id
                  WHERE c.agent_id = s.agent_id
                    AND t.status IN ('queued', 'dispatched', 'running')
                )
                -- §3.9 keep-awake: live background work holds the box up
                -- (keepAwakeExists above — one definition, negated here).
                AND NOT ${keepAwakeExists()}
              ORDER BY s.last_active_at ASC
              LIMIT ${remaining}
              FOR UPDATE OF s SKIP LOCKED
            )
            UPDATE sandboxes s SET status = 'stopping', updated_at = now()
            FROM claimed c
            WHERE s.id = c.id
            RETURNING s.id, s.agent_id, s.container_ref
          `
        : [];

    // THE HELD-AWAKE CEILING (step 13). Keep-awake above is a promise —
    // "a box observing live work stays up" — and unbounded it is a
    // legitimate-usage path to wedging the host: held boxes never park, each
    // holds a placement slot, and nothing else ever releases them. Over the
    // ceiling, the OLDEST-idle held boxes lose the exemption and are
    // reclaimed by the ordinary stop path (LRU — the ORDER BY is the
    // eviction policy). Everything downstream is machinery that already
    // exists: the stop terminalizes the processes via the lost sweep, the
    // watch coherence sweep converts armed watches to `triggered` with
    // trigger='lost', and the fired watch delivers the honest "the process
    // was lost" report to the origin conversation. The active-turn guard
    // still applies — a box mid-conversation is never evicted — and the arm
    // is runner-fenced like every other, so one runner's runaway can only
    // evict within that runner.
    const remainingAfterStops = remaining - stops.length;
    let evictions: ClaimedRow[] = [];
    if (remainingAfterStops > 0) {
      const runner = await tx.runner.findUnique({
        where: { id: runnerId },
        select: { capabilities: true },
      });
      const ceiling = heldAwakeCeilingFor(runner?.capabilities);
      const [counted] = await tx.$queryRaw<[{ held: number }]>`
        SELECT count(*)::int AS held FROM sandboxes s
        WHERE s.runner_id = ${runnerId}
          AND s.status = 'running'
          AND ${keepAwakeExists()}
      `;
      const excess = (counted?.held ?? 0) - ceiling;
      if (excess > 0) {
        evictions = await tx.$queryRaw<ClaimedRow[]>`
          WITH claimed AS (
            SELECT s.id FROM sandboxes s
            WHERE s.runner_id = ${runnerId}
              AND s.status = 'running'
              AND s.last_active_at IS NOT NULL
              AND s.last_active_at < ${idleBefore}
              AND NOT EXISTS (
                SELECT 1 FROM conversations c
                JOIN turns t ON t.conversation_id = c.id
                WHERE c.agent_id = s.agent_id
                  AND t.status IN ('queued', 'dispatched', 'running')
              )
              AND ${keepAwakeExists()}
            ORDER BY s.last_active_at ASC
            LIMIT ${Math.min(excess, remainingAfterStops)}
            FOR UPDATE OF s SKIP LOCKED
          )
          UPDATE sandboxes s SET status = 'stopping', updated_at = now()
          FROM claimed c
          WHERE s.id = c.id
          RETURNING s.id, s.agent_id, s.container_ref
        `;
      }
    }

    // Aborts first: someone is waiting on a stop, and they are cheap.
    //
    // This CLAIMS rather than reads — clearing the flag is what makes the
    // abort deliver once. Leaving it set would re-deliver on every poll until
    // the turn actually ended, and since a poll returns immediately whenever
    // work exists, that is a busy loop between runner and control plane for
    // the whole duration of the abort. A claim that is then lost (the runner
    // died holding it) is recovered two ways: the user can ask again, and
    // `reclaimStaleTurns` fails the turn regardless.
    //
    // `updated_at` IS stamped, and it has to be. The turn arm below
    // re-delivers a turn left `dispatched` past the stale window — and
    // `SKIP LOCKED` does not skip a row THIS transaction already locked, so
    // without the stamp a stale turn is aborted by this arm and handed
    // straight back by that one, in the same poll: the user presses Stop and
    // the agent starts the cancelled work again. An abort is activity on the
    // re-delivery clock.
    //
    // (An earlier comment justified NOT stamping, to avoid postponing the
    // reclaim deadline. Obsolete: `reclaimStaleTurns` measures from
    // `created_at`, which no `updated_at` write can move.)
    //
    // `failed` is in the status list for the sweeps: they set the flag while
    // failing a turn administratively (ceiling or stall) with the sandbox
    // still working, and this arm is how that orphaned work actually gets
    // stopped instead of burning tokens under a row nobody is reading. (The
    // user route can also leave the flag on a failed row by losing a race
    // with a strand door — see abortTurn's comment; delivering that abort is
    // equally right, and the supervisor's id check drops any that arrive
    // after the work already ended.)
    const aborts = await tx.$queryRaw<AbortRow[]>`
      WITH claimed AS (
        SELECT t.id
        FROM turns t
        JOIN conversations c ON c.id = t.conversation_id
        JOIN sandboxes s ON s.agent_id = c.agent_id
        WHERE s.runner_id = ${runnerId}
          AND t.abort_requested = true
          AND t.status IN ('dispatched', 'running', 'failed')
        ORDER BY t.created_at ASC
        LIMIT ${TURN_LIMIT}
        FOR UPDATE OF t SKIP LOCKED
      )
      UPDATE turns t SET abort_requested = false, updated_at = now()
      FROM claimed cl
      WHERE t.id = cl.id
      RETURNING
        t.id,
        t.conversation_id,
        (SELECT s.id FROM conversations c
           JOIN sandboxes s ON s.agent_id = c.agent_id
          WHERE c.id = t.conversation_id) AS sandbox_id
    `;

    // Mid-run follow-ups ready to steer. Three predicates carry the design:
    //
    // - `steer_delivered_at IS NULL` — a steer is delivered AT MOST ONCE.
    //   There is no re-delivery window on purpose: a lost steer's recovery
    //   is promotion (the message runs as the next turn), never a re-send
    //   that could inject the same words into the live run twice.
    // - The FIFO guard — a newer message must never steer PAST an older
    //   sibling: not past one still parked (undelivered), and not past one
    //   delivered toward a DIFFERENT turn (that one can only re-enter as a
    //   promoted turn, i.e. AFTER the newer words would have joined the live
    //   run). An older sibling already delivered toward the SAME live target
    //   does NOT block: both ride one socket in claim order and jcode's
    //   interrupt queue drains FIFO, so order holds — without this carve-out
    //   at most ONE message could ever steer into a run and every later one
    //   silently degraded to promotion.
    // - The runner capability gate — the runner's poll parse is
    //   all-or-nothing, so an unknown work kind would poison whole claimed
    //   batches on an older runner. A runner that never advertised
    //   `steerMessages` simply never receives one; its follow-ups promote.
    // - The ATTACHMENT carve-out — a follow-up carrying attachments is NEVER
    //   steered (decided at planning, with the user): the harness's live
    //   injection surface is text-only at our integration layer, so the
    //   files could not ride along. It parks and promotes at the target's
    //   close, running as its own turn with full delivery + inline vision.
    //   Race-free by construction: the bind commits in the follow-up's own
    //   create transaction, so this predicate can never observe the row
    //   before its attachments. The FIFO guard below then also parks LATER
    //   text follow-ups behind it — order preserved, accepted cost.
    //
    // The target must already be handed over (`dispatched`/`running`): a
    // steer for a still-queued turn waits here — the supervisor could not
    // act on it yet, and the claim is one-shot.
    const steers = await tx.$queryRaw<SteerRow[]>`
      WITH claimed AS (
        SELECT f.id
        FROM turns f
        JOIN turns target ON target.id = f.follow_up_of_turn_id
        JOIN conversations c ON c.id = f.conversation_id
        JOIN sandboxes s ON s.agent_id = c.agent_id
        JOIN runners r ON r.id = s.runner_id
        WHERE s.runner_id = ${runnerId}
          AND s.status = 'running'
          AND f.status = 'joining'
          AND f.steer_delivered_at IS NULL
          AND target.status IN ('dispatched', 'running')
          AND (r.capabilities->>'steerMessages')::boolean IS TRUE
          AND NOT EXISTS (
            SELECT 1 FROM conversation_attachments att
            WHERE att.turn_id = f.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM turns older
            WHERE older.conversation_id = f.conversation_id
              AND older.status = 'joining'
              AND older.created_at < f.created_at
              AND (
                older.steer_delivered_at IS NULL
                OR older.follow_up_of_turn_id IS DISTINCT FROM f.follow_up_of_turn_id
              )
          )
        ORDER BY f.created_at ASC
        LIMIT ${TURN_LIMIT}
        FOR UPDATE OF f SKIP LOCKED
      )
      UPDATE turns f SET steer_delivered_at = now(), updated_at = now()
      FROM claimed cl
      WHERE f.id = cl.id
      RETURNING
        f.id,
        f.conversation_id,
        f.follow_up_of_turn_id,
        (SELECT s.id FROM conversations c
           JOIN sandboxes s ON s.agent_id = c.agent_id
          WHERE c.id = f.conversation_id) AS sandbox_id,
        f.message
    `;

    // Home syncs (step 9), BEFORE turns on purpose: the composed items
    // keep this order, the runner executes serially, so in a wake batch the
    // projection lands before the first turn's frames. Claiming stamps ONLY
    // the pacing clock — `applied` moves on the supervisor's ack alone, so a
    // claim lost anywhere re-arms after the window with nothing lost.
    const syncs = await tx.$queryRaw<SyncRow[]>`
      WITH claimed AS (
        SELECT s.id FROM sandboxes s
        WHERE s.runner_id = ${runnerId}
          AND s.status = 'running'
          AND s.home_applied_generation < s.home_desired_generation
          AND (s.home_sync_claimed_at IS NULL
               OR s.home_sync_claimed_at < ${syncRetryBefore})
        ORDER BY s.updated_at ASC
        LIMIT ${HOME_SYNC_LIMIT}
        FOR UPDATE OF s SKIP LOCKED
      )
      UPDATE sandboxes s SET home_sync_claimed_at = now()
      FROM claimed c
      WHERE s.id = c.id
      RETURNING s.id, s.agent_id, s.home_desired_generation
    `;

    // THE APPROACHING-CEILING WARNING. A running turn inside the warning
    // window gets one steer telling the agent to wrap up: report the status
    // of anything it is supervising and end the turn cleanly — instead of
    // reclaimStaleTurns killing it mid-wait with no handoff. It rides the
    // existing `turn.message` wire with a SYNTHETIC id (the row's own id,
    // prefixed): the supervisor injects it like any steer, and the outcome it
    // reports for that id matches no follow-up row, so the settle pass
    // no-ops — exactly the right amount of bookkeeping for a message that
    // has no row. `ceiling_warned_at` is the once-fence, stamped in the same
    // claim (a lost claim is not retried on purpose: the warning is best
    // effort, the ceiling itself is the guarantee). Same capability gate as
    // steers — an older runner would poison its poll batch on the kind, and
    // its turns just meet the ceiling the way they always have. Measured
    // from the same clock as the sweep, so the two arms agree on age.
    const warnBefore = new Date(
      Date.now() - (TURN_CEILING_SECONDS - TURN_CEILING_WARNING_SECONDS) * 1000,
    );
    const ceilingWarnings = await tx.$queryRaw<
      { id: string; conversation_id: string; sandbox_id: string | null }[]
    >`
      WITH claimed AS (
        SELECT t.id
        FROM turns t
        JOIN conversations c ON c.id = t.conversation_id
        JOIN sandboxes s ON s.agent_id = c.agent_id
        JOIN runners r ON r.id = s.runner_id
        WHERE s.runner_id = ${runnerId}
          AND s.status = 'running'
          AND t.status = 'running'
          AND t.ceiling_warned_at IS NULL
          AND COALESCE(t.retried_at, t.promoted_at, t.created_at) < ${warnBefore}
          AND (r.capabilities->>'steerMessages')::boolean IS TRUE
        ORDER BY t.created_at ASC
        LIMIT ${TURN_LIMIT}
        FOR UPDATE OF t SKIP LOCKED
      )
      UPDATE turns t SET ceiling_warned_at = now()
      FROM claimed cl
      WHERE t.id = cl.id
      RETURNING
        t.id,
        t.conversation_id,
        (SELECT s.id FROM conversations c
           JOIN sandboxes s ON s.agent_id = c.agent_id
          WHERE c.id = t.conversation_id) AS sandbox_id
    `;

    // Turns whose sandbox is actually up. A queued turn on a sleeping sandbox
    // waits here until the start arm has woken it and the supervisor reported
    // ready — which is why `createTurn` flips a stopped sandbox itself.
    const turns = await tx.$queryRaw<ClaimedTurnRow[]>`
      WITH claimed AS (
        SELECT t.id
        FROM turns t
        JOIN conversations c ON c.id = t.conversation_id
        JOIN sandboxes s ON s.agent_id = c.agent_id
        WHERE s.runner_id = ${runnerId}
          AND s.status = 'running'
          AND (
            t.status = 'queued'
            OR (t.status = 'dispatched' AND t.updated_at < ${staleDispatch})
          )
        -- WAKE PRIORITY, same rank as the start arm: within one poll's turn
        -- budget a person's message dispatches before a scheduled run's.
        ORDER BY
          CASE WHEN ${userVisibleTurn(priorityAgeBefore)} THEN 0 ELSE 1 END,
          t.created_at ASC
        LIMIT ${TURN_LIMIT}
        FOR UPDATE OF t SKIP LOCKED
      )
      UPDATE turns t SET status = 'dispatched', updated_at = now()
      FROM claimed cl
      WHERE t.id = cl.id
      RETURNING
        t.id,
        t.conversation_id,
        (SELECT s.id FROM conversations c
           JOIN sandboxes s ON s.agent_id = c.agent_id
          WHERE c.id = t.conversation_id) AS sandbox_id,
        (SELECT c.agent_id FROM conversations c
          WHERE c.id = t.conversation_id) AS agent_id,
        t.message,
        (SELECT c.harness_session_ref FROM conversations c
          WHERE c.id = t.conversation_id) AS harness_session_ref,
        -- The claim-latency clock (step 6 telemetry): the same expression
        -- the turn-budget sweeps measure from — a promoted follow-up or an
        -- auto-retried turn deliberately restarts it.
        COALESCE(t.retried_at, t.promoted_at, t.created_at) AS waited_since
    `;

    return [
      ...starts.map(
        (row): DueStart => ({
          kind: "start",
          sandboxId: row.id,
          agentId: row.agent_id,
        }),
      ),
      // Ceiling evictions ride the ordinary stop shape — the runner cannot
      // tell them apart, deliberately (a stop is a stop).
      ...[...stops, ...evictions].map(
        (row): DueStop => ({
          kind: "stop",
          sandboxId: row.id,
          containerRef: row.container_ref,
        }),
      ),
      // `sandbox_id` comes from a correlated subquery, so it is nullable in
      // principle even though both CTEs join `sandboxes` and `Sandbox.agentId`
      // is `@unique`. A row without one names nowhere to deliver, so it is
      // dropped rather than shipped as a lie about a sandbox that isn't there.
      ...aborts.flatMap((row): DueTurnAbort[] =>
        row.sandbox_id
          ? [
              {
                kind: "turn.abort",
                turnId: row.id,
                conversationId: row.conversation_id,
                sandboxId: row.sandbox_id,
              },
            ]
          : [],
      ),
      ...syncs.map(
        (row): DueHomeSync => ({
          kind: "home.sync",
          sandboxId: row.id,
          agentId: row.agent_id,
          generation: row.home_desired_generation,
        }),
      ),
      ...turns.flatMap((row): DueTurn[] =>
        row.sandbox_id && row.agent_id
          ? [
              {
                kind: "turn",
                turnId: row.id,
                conversationId: row.conversation_id,
                sandboxId: row.sandbox_id,
                agentId: row.agent_id,
                message: row.message,
                resumeSessionRef: row.harness_session_ref,
                waitedSince: row.waited_since,
              },
            ]
          : [],
      ),
      // Steers LAST, after the turn arm: within one composed batch the
      // runner executes serially, so a same-poll deliver+steer pair reaches
      // the supervisor in deliver-first order.
      ...steers.flatMap((row): DueTurnMessage[] =>
        row.sandbox_id
          ? [
              {
                kind: "turn.message",
                turnId: row.id,
                targetTurnId: row.follow_up_of_turn_id,
                conversationId: row.conversation_id,
                sandboxId: row.sandbox_id,
                message: row.message,
              },
            ]
          : [],
      ),
      // Ceiling warnings ride the same steer shape — the synthetic id is
      // namespaced so a `turn.result` outcome for it can never collide with
      // a real follow-up row's id (uuids have no colon).
      ...ceilingWarnings.flatMap((row): DueTurnMessage[] =>
        row.sandbox_id
          ? [
              {
                kind: "turn.message",
                turnId: `ceiling-warning:${row.id}`,
                targetTurnId: row.id,
                conversationId: row.conversation_id,
                sandboxId: row.sandbox_id,
                message: TURN_CEILING_WARNING_MESSAGE,
              },
            ]
          : [],
      ),
    ];
  });
};

/**
 * Conversations owing a promotion: a parked follow-up with nothing active in
 * front of it. Dueness only (invariant 15) — the promotion itself lives in
 * turn-service, orchestrated by follow-up-service's poll pass. Bounded per
 * pass; the next poll continues where this one stopped.
 */
export const listConversationsWithParkedFollowUps = async (): Promise<
  string[]
> => {
  const rows = await db.$queryRaw<{ conversation_id: string }[]>`
    SELECT DISTINCT f.conversation_id
    FROM turns f
    WHERE f.status = 'joining'
      AND NOT EXISTS (
        SELECT 1 FROM turns a
        WHERE a.conversation_id = f.conversation_id
          AND a.status IN ('queued', 'dispatched', 'running')
      )
    LIMIT 20
  `;
  return rows.map((row) => row.conversation_id);
};

/**
 * Fail turns that have outlived the ceiling, so their conversations unblock.
 *
 * Event reporting is fire-and-forget by design (§3 — a failed report must not
 * take the runner down), and a sandbox can wedge without ever disconnecting,
 * so a turn CAN stop progressing with nothing else noticing. The active-turn
 * index turns that into a permanently unusable conversation, which is the
 * failure this sweep exists to prevent.
 *
 * `queued` is included: a turn whose sandbox never comes up was never anyone's
 * to dispatch, and blocks its conversation just as thoroughly.
 *
 * Called from the runner work poll — the control plane's only regular tick
 * (§3.3: there is no background loop anywhere).
 */
export const reclaimStaleTurns = async (): Promise<SweptTurn[]> => {
  // Measured from CREATION, not `updated_at`: the re-dispatch arm above
  // stamps `updated_at` every time it hands a stale turn back to a runner,
  // so an `updated_at` deadline is one a re-dispatching turn postpones
  // forever — the sweep would never fire for the exact turns it exists to
  // rescue. `created_at` only ever ages.
  //
  // A PROMOTED follow-up measures from `promoted_at` instead: it may have
  // sat parked through most of its target's long run, and inheriting that
  // elapsed time would end it minutes after it finally started — with copy
  // about a time limit it never actually used. A REVIVED turn (the cold-boot
  // auto-retry) measures from `retried_at` for the same reason: attempt two
  // deserves a full budget, not attempt one's remainder. (Each clock is
  // one-way and newer than the last, so a deadline only ever moves later.)
  //
  // The copy tells two truths, not one: a turn whose `started_at` is NULL
  // never ran for a second — its sandbox never came up — and burying it
  // under the time-limit copy was a lie users acted on. It gets the
  // never-started copy plus the code that renders it as a quiet notice.
  //
  // A STARTED turn also gets `abort_requested = true` in the same statement:
  // failing the row unblocks the conversation, but the sandbox is still
  // working — the abort claim arm (its `failed` leg) is what actually stops
  // that orphan on the owning runner's next poll. A never-started turn has
  // nothing to stop, so the flag is cleared rather than set there.
  //
  // Two clocks, deliberately: the full ceiling is a WORK budget, and a turn
  // whose `started_at` is NULL never worked a second — it is a start that
  // wedged past every faster door (patience parks at 150s, stale claims
  // re-claim at 300s, a REPORTED death revives or strands immediately), so
  // giving it the whole 6h before "the agent never got to this message"
  // would block the conversation for hours to say nothing happened. It keeps
  // the old 30-minute bound (or the ceiling itself when the operator sets
  // one lower).
  const ceiling = new Date(Date.now() - TURN_CEILING_SECONDS * 1000);
  const neverStartedCeiling = new Date(
    Date.now() - Math.min(TURN_CEILING_SECONDS, 1800) * 1000,
  );
  const swept = await db.$queryRaw<SweptTurnRow[]>`
    UPDATE turns SET
      status = 'failed',
      error = CASE WHEN started_at IS NULL
        THEN ${AGENT_NEVER_STARTED_MESSAGE}
        ELSE ${TURN_TIME_LIMIT_MESSAGE} END,
      error_code = CASE WHEN started_at IS NULL
        THEN 'agent_start_failed'
        ELSE 'turn_time_limit' END,
      abort_requested = (started_at IS NOT NULL),
      finished_at = now(),
      updated_at = now()
    WHERE status IN ('queued', 'dispatched', 'running')
      AND COALESCE(retried_at, promoted_at, created_at) <
        CASE WHEN started_at IS NULL
          THEN ${neverStartedCeiling}
          ELSE ${ceiling} END
    RETURNING id, conversation_id, (started_at IS NULL) AS never_started
  `;

  if (swept.length > 0) {
    log.warn({ active: swept.length }, "reclaimed turns past the ceiling");
  }
  return swept.map((row) => ({
    turnId: row.id,
    conversationId: row.conversation_id,
    error: row.never_started
      ? AGENT_NEVER_STARTED_MESSAGE
      : TURN_TIME_LIMIT_MESSAGE,
    errorCode: row.never_started ? "agent_start_failed" : "turn_time_limit",
  }));
};

/**
 * Fail RUNNING turns whose liveness clock went silent — the primary wedge
 * detector. The supervisor heartbeats `last_progress_at` (~60s) for the whole
 * life of a turn, whatever the agent is doing, so a stamp older than the
 * stall window means the thing writing it is gone: the sandbox died without
 * reporting, wedged, or lost its channel. The ceiling above still backstops
 * everything, but this is what turns "wait out the whole ceiling" into
 * minutes.
 *
 * `last_progress_at IS NOT NULL` is the skew fence: a turn run by an agent
 * image that predates the heartbeat never stamps the clock, and this arm
 * must never touch it — it stays ceiling-bounded exactly as before.
 *
 * Same posture as the ceiling sweep: raw fail + `abort_requested`, with the
 * abort claim arm stopping the (possibly still live) worker, and the caller
 * settling automation bookkeeping from the returned rows.
 */
export const failStalledTurns = async (): Promise<SweptTurn[]> => {
  const stallBefore = new Date(Date.now() - TURN_STALL_SECONDS * 1000);
  const swept = await db.$queryRaw<{ id: string; conversation_id: string }[]>`
    UPDATE turns SET
      status = 'failed',
      error = ${TURN_STALLED_MESSAGE},
      error_code = 'turn_stalled',
      abort_requested = true,
      finished_at = now(),
      updated_at = now()
    WHERE status = 'running'
      AND last_progress_at IS NOT NULL
      AND last_progress_at < ${stallBefore}
    RETURNING id, conversation_id
  `;
  if (swept.length > 0) {
    log.warn(
      { stalled: swept.length },
      "failed turns with a stalled heartbeat",
    );
  }
  return swept.map((row) => ({
    turnId: row.id,
    conversationId: row.conversation_id,
    error: TURN_STALLED_MESSAGE,
    errorCode: "turn_stalled",
  }));
};

/**
 * Fail parked follow-ups that are genuinely WEDGED: `joining` a whole turn
 * ceiling later with NOTHING active in front of them. The no-active guard is
 * what makes this a wedge detector rather than a queue killer — a follow-up
 * parked behind a live turn is healthy by definition (that turn is itself
 * ceiling-bounded), and one whose conversation just freed up is promotion's
 * to run, not this sweep's to bury.
 *
 * Called from the poll AFTER the promotion pass, deliberately: in the same
 * poll that ceiling-fails a long turn, promotion runs first and re-occupies
 * the conversation with the oldest parked message — so its siblings are
 * protected by the guard instead of dying in the gap between the two passes.
 */
export const expireWedgedFollowUps = async (): Promise<number> => {
  const ceiling = new Date(Date.now() - TURN_CEILING_SECONDS * 1000);
  const count = await db.$executeRaw`
    UPDATE turns SET
      status = 'failed',
      error = ${FOLLOW_UP_EXPIRED_MESSAGE},
      finished_at = now(),
      updated_at = now()
    WHERE status = 'joining'
      AND created_at < ${ceiling}
      AND NOT EXISTS (
        SELECT 1 FROM turns a
        WHERE a.conversation_id = turns.conversation_id
          AND a.status IN ('queued', 'dispatched', 'running')
      )
  `;
  if (count > 0) log.warn({ count }, "expired wedged follow-ups");
  return count;
};

// ── Scheduled tasks (step 7) ────────────────────────────────────────────

/** Crons fired per poll — its own budget, like TURN_LIMIT: a burst of due
 * schedules must not starve lifecycle work, and vice versa. */
export const CRON_FIRE_LIMIT = 10;

/**
 * The claim's lease. Claiming stamps `next_fire_at = now() + this` in the
 * same locked statement, so concurrent pollers skip the row without any
 * marker column — and a poller that dies between claiming and stamping the
 * real next occurrence merely retries the fire five minutes late, it never
 * loses the schedule.
 */
const CRON_LEASE_SECONDS = 300;

export interface DueCron {
  id: string;
  agentId: string;
  workspaceId: string;
  name: string;
  prompt: string;
  schedule: string;
  timezone: string;
  originConversationId: string | null;
  createdByUserId: string | null;
}

interface DueCronRow {
  id: string;
  agent_id: string;
  workspace_id: string;
  name: string;
  prompt: string;
  schedule: string;
  timezone: string;
  origin_conversation_id: string | null;
  created_by_user_id: string | null;
}

/**
 * Claim due schedules, atomically. Same CTE + `FOR UPDATE … SKIP LOCKED`
 * law as every arm above (and the same reason: the IN-subquery form re-runs
 * per candidate and blows past the limit). The UPDATE inside the claim is
 * the lease — see CRON_LEASE_SECONDS.
 *
 * Deliberately NOT runner-fenced: firing a cron is creating a turn (the same
 * act as a user pressing send), not executing sandbox work — whichever
 * poller gets here first may do it, and the lease is what makes "first"
 * exclusive. The turn it creates is then delivered under the normal
 * runner-fenced arms.
 *
 * FIRING lives in cron-fire-service, not here: this module owns dueness and
 * claims (invariant 15), never conversations.
 */
export const claimDueCrons = async (): Promise<{
  /** The exact stamped lease — the CAS token `advanceClaimedCron` matches. */
  lease: Date;
  crons: DueCron[];
}> => {
  const now = new Date();
  const lease = new Date(Date.now() + CRON_LEASE_SECONDS * 1000);
  const rows = await db.$queryRaw<DueCronRow[]>`
    WITH claimed AS (
      SELECT c.id
      FROM agent_crons c
      WHERE c.enabled = true
        AND c.next_fire_at <= ${now}
      ORDER BY c.next_fire_at ASC
      LIMIT ${CRON_FIRE_LIMIT}
      FOR UPDATE OF c SKIP LOCKED
    )
    UPDATE agent_crons c
    SET next_fire_at = ${lease}, updated_at = now()
    FROM claimed cl
    WHERE c.id = cl.id
    RETURNING
      c.id,
      c.agent_id,
      (SELECT a.workspace_id FROM agents a WHERE a.id = c.agent_id) AS workspace_id,
      c.name,
      c.prompt,
      c.schedule,
      c.timezone,
      c.origin_conversation_id,
      c.created_by_user_id
  `;
  return {
    lease,
    crons: rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      workspaceId: row.workspace_id,
      name: row.name,
      prompt: row.prompt,
      schedule: row.schedule,
      timezone: row.timezone,
      originConversationId: row.origin_conversation_id,
      createdByUserId: row.created_by_user_id,
    })),
  };
};

/**
 * Advance a claimed cron from its lease to the real next occurrence — but
 * only if the lease is still ours (`next_fire_at` unchanged). A concurrent
 * human edit recomputes `next_fire_at` through the service; losing this CAS
 * means the schedule changed under the claim, and the fire must be skipped
 * rather than run with a prompt the user may have just replaced.
 */
export const advanceClaimedCron = async (
  cronId: string,
  expectedLease: Date,
  nextFireAt: Date,
): Promise<boolean> => {
  const { count } = await db.agentCron.updateMany({
    where: {
      id: cronId,
      // Tolerate sub-second drift between our Date and what Postgres stored:
      // equality on the exact lease value, which we computed and stamped.
      nextFireAt: expectedLease,
    },
    data: { nextFireAt, lastFiredAt: new Date() },
  });
  return count > 0;
};

// ── Background-process watches (step 10) ─────────────────────────────────────
// The durable side of the watch model. The supervisor detects exit/pattern/
// silence in memory and reports triggers; the control plane owns the outcomes
// the supervisor CANNOT (its container may have died): converting armed
// watches on dead processes, expiring forgotten ones, and firing turns. All
// three are idempotent monotone transitions — no lock needed — except the
// fire CLAIM, which takes the CTE + lease law like every other claim here.

export const WATCH_FIRE_LIMIT = 10;
/** The fire claim's lease — the single-purpose clock (`fire_claimed_at`,
 * never `updated_at`). A poller dying mid-fire retries after this, at
 * most-once-per-lease, exactly like a cron. */
const WATCH_FIRE_LEASE_SECONDS = 300;

/**
 * A running process whose sandbox is down, or whose container_ref no longer
 * matches the sandbox's current one, is LOST (step 10). Excludes `starting`
 * deliberately: a report race can briefly show a starting sandbox with the
 * old ref, and recreate-on-start always changes the ref, so the mismatch
 * term catches the real death on the next pass without a spurious hit.
 */
export const sweepLostProcesses = async (): Promise<number> =>
  db.$executeRaw`
    UPDATE sandbox_processes p
    SET status = 'lost', ended_at = now(), updated_at = now()
    FROM sandboxes s
    WHERE p.sandbox_id = s.id
      AND p.status = 'running'
      AND (
        s.status IN ('stopped', 'failed', 'stopping')
        OR (s.container_ref IS NOT NULL AND p.container_ref <> s.container_ref)
      )
  `;

/**
 * Any watch still `armed` on a process that has reached a terminal state is
 * converted to `triggered` — with `lost` when the process was lost, else
 * `exited`. This is the coherence net that closes the dropped-frame hole: if
 * the supervisor's own exit-trigger frame was lost, the watch would otherwise
 * sit armed on a corpse forever (and hold keep-awake until expiry).
 */
export const sweepWatchCoherence = async (): Promise<number> =>
  db.$executeRaw`
    UPDATE process_watches w
    SET status = 'triggered',
        trigger = CASE WHEN p.status = 'lost' THEN 'lost' ELSE 'exited' END,
        triggered_at = now(), updated_at = now()
    FROM sandbox_processes p
    WHERE w.process_id = p.id
      AND w.status = 'armed'
      AND p.status IN ('exited', 'stopped', 'lost')
  `;

/** Armed watches past their deadline expire — terminal, and NEVER a turn. */
export const sweepExpiredWatches = async (): Promise<number> =>
  db.processWatch
    .updateMany({
      where: { status: "armed", expiresAt: { lt: new Date() } },
      data: { status: "expired" },
    })
    .then((result) => result.count);

export interface DueWatchFire {
  id: string;
  kind: string;
  trigger: string | null;
  prompt: string;
  excerpt: string | null;
  processName: string | null;
  processCommand: string;
  exitCode: number | null;
  agentId: string;
  workspaceId: string;
  originConversationId: string | null;
  createdByUserId: string | null;
}

interface DueWatchFireRow {
  id: string;
  kind: string;
  trigger: string | null;
  prompt: string;
  excerpt: string | null;
  process_name: string | null;
  process_command: string;
  exit_code: number | null;
  agent_id: string;
  workspace_id: string;
  origin_conversation_id: string | null;
  created_by_user_id: string | null;
}

/**
 * Claim triggered watches to fire, atomically — the CTE + lease law (NOT the
 * IN-subquery form, for the same reason as every arm above). Not
 * runner-fenced: firing is turn creation, whichever poller wins. `status`
 * moves to `fired` in watch-fire-service once the turn is created — a poller
 * dying between claim and fire retries after the lease, at-most-once.
 */
export const claimTriggeredWatches = async (): Promise<DueWatchFire[]> => {
  const retryBefore = new Date(Date.now() - WATCH_FIRE_LEASE_SECONDS * 1000);
  const rows = await db.$queryRaw<DueWatchFireRow[]>`
    WITH claimed AS (
      SELECT w.id FROM process_watches w
      WHERE w.status = 'triggered'
        AND (w.fire_claimed_at IS NULL OR w.fire_claimed_at < ${retryBefore})
      ORDER BY w.triggered_at ASC
      LIMIT ${WATCH_FIRE_LIMIT}
      FOR UPDATE OF w SKIP LOCKED
    )
    UPDATE process_watches w
    SET fire_claimed_at = now(), updated_at = now()
    FROM claimed cl
    WHERE w.id = cl.id
    RETURNING
      w.id, w.kind, w.trigger, w.prompt, w.excerpt,
      w.origin_conversation_id, w.created_by_user_id,
      (SELECT p.name FROM sandbox_processes p WHERE p.id = w.process_id) AS process_name,
      (SELECT p.command FROM sandbox_processes p WHERE p.id = w.process_id) AS process_command,
      (SELECT p.exit_code FROM sandbox_processes p WHERE p.id = w.process_id) AS exit_code,
      (SELECT a.id FROM sandbox_processes p
        JOIN sandboxes s ON s.id = p.sandbox_id
        JOIN agents a ON a.id = s.agent_id WHERE p.id = w.process_id) AS agent_id,
      (SELECT a.workspace_id FROM sandbox_processes p
        JOIN sandboxes s ON s.id = p.sandbox_id
        JOIN agents a ON a.id = s.agent_id WHERE p.id = w.process_id) AS workspace_id
  `;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    trigger: row.trigger,
    prompt: row.prompt,
    excerpt: row.excerpt,
    processName: row.process_name,
    processCommand: row.process_command,
    exitCode: row.exit_code,
    agentId: row.agent_id,
    workspaceId: row.workspace_id,
    originConversationId: row.origin_conversation_id,
    createdByUserId: row.created_by_user_id,
  }));
};

/**
 * Release a claim the runner could not act on (e.g. its agent vanished
 * mid-dispatch), so the next poll reconsiders it instead of waiting out the
 * stale-claim window.
 */
export const releaseClaim = async (sandboxId: string, runnerId: string) => {
  await db.sandbox.updateMany({
    where: { id: sandboxId, runnerId, status: "starting" },
    data: { status: "unprovisioned" },
  });
};

/**
 * Park a claim the control plane REFUSED to compose, as opposed to
 * `releaseClaim`, which puts it straight back in the queue.
 *
 * The difference is the backoff, and it is the whole point. Look at the start
 * arm above: `unprovisioned` is claimed unconditionally, because a parked
 * sandbox must wake the instant a message arrives. Only `failed` is paced by
 * `retryBefore`. So releasing a claim we will refuse again produces exactly
 * the hot loop that term was added to kill — claim, refuse, release, claim,
 * at two HTTP round trips per cycle, for as long as the condition lasts. And
 * "no model key" lasts until a human grants one.
 *
 * The queued turns are failed in the same transaction. They cannot run, and
 * left alone they would sit until the turn ceiling swept them with a message
 * about time limits that says nothing true about why.
 */
export const parkUnstartableClaim = async (
  sandboxId: string,
  runnerId: string,
  reason: { message: string; code: string },
): Promise<void> => {
  await db.$transaction(async (tx) => {
    const { count } = await tx.sandbox.updateMany({
      where: { id: sandboxId, runnerId, status: "starting" },
      data: { status: "failed" },
    });
    if (count === 0) return;
    const sandbox = await tx.sandbox.findUnique({
      where: { id: sandboxId },
      select: { agentId: true },
    });
    if (!sandbox) return;
    await tx.turn.updateMany({
      where: {
        conversation: { agentId: sandbox.agentId },
        // Parked follow-ups fail too: they wait on turns that cannot run,
        // and the fix ("connect a model key") is the same fix.
        status: { in: [...ACTIVE_TURN_STATUSES, "joining"] },
      },
      data: {
        status: "failed",
        error: reason.message,
        errorCode: reason.code,
        finishedAt: new Date(),
      },
    });
  });
};

// ── The wait-for-work signal ────────────────────────────────────────────

type Waiter = () => void;
const waiters = new Set<Waiter>();

/**
 * Wake every held poll. Called wherever work becomes due out-of-band (a
 * hosted agent created, a token regenerated). In-process by design: v2 runs
 * one api instance per install, and a missed wake costs one re-check
 * interval, never a lost item — dueness is always recomputed from Postgres.
 */
export const signalWork = (): void => {
  for (const waiter of [...waiters]) {
    waiters.delete(waiter);
    try {
      waiter();
    } catch (err) {
      log.warn({ err }, "work waiter threw");
    }
  }
};

/** Resolve when work is signalled or `timeoutMs` elapses, whichever is first. */
export const waitForWork = (timeoutMs: number): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      waiters.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    // Never keep the process alive for a poll that is only waiting.
    timer.unref?.();
    waiters.add(finish);
  });

/** Test seam: the number of polls currently parked on the signal. */
export const pendingWaiterCount = (): number => waiters.size;

// ── Held-awake signal reads (step 13) ───────────────────────────────────
//
// The dashboard's view of the same keepAwakeExists predicate — living here
// because invariant 15 puts every reading of "what holds a box up" in this
// module, so the signal can never drift from the enforcement.

/**
 * Which of a workspace's agents currently hold a box awake with live
 * background work — the per-agent "working in the background" signal, in one
 * grouped query.
 */
export const agentIdsWithLiveBackgroundWork = async (
  workspaceId: string,
): Promise<Set<string>> => {
  const rows = await db.$queryRaw<Array<{ agent_id: string }>>`
    SELECT DISTINCT s.agent_id FROM sandboxes s
    JOIN agents a ON a.id = s.agent_id
    WHERE a.workspace_id = ${workspaceId}
      AND s.status = 'running'
      AND ${keepAwakeExists()}
  `;
  return new Set(rows.map((row) => row.agent_id));
};

/**
 * Held-awake counts per runner — the operator number beside each runner's
 * ceiling on the admin-gated runners read (never a web page, §3.13).
 */
export const heldAwakeCountsByRunner = async (): Promise<
  Map<string, number>
> => {
  const rows = await db.$queryRaw<Array<{ runner_id: string; held: number }>>`
    SELECT s.runner_id, count(*)::int AS held FROM sandboxes s
    WHERE s.status = 'running'
      AND ${keepAwakeExists()}
    GROUP BY s.runner_id
  `;
  return new Map(rows.map((row) => [row.runner_id, row.held]));
};
