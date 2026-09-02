import { db, Prisma } from "@onecli/db";
import {
  TURN_FAILURE_CODES,
  type AgentEvent,
  type TurnUsage,
} from "@onecli/agent-protocol";
import { ServiceError } from "./errors";
import {
  releaseWatchFireClaimsForConversation,
  signalWork,
  type SweptTurn,
} from "./due-work";
import { type PublishedEvent } from "./event-bus";
import { getEventBus } from "../providers/event-bus";
import {
  requireConversation,
  requireDirectWakeConversation,
  requireSystemConversation,
} from "./conversation-service";
import { findAgentLlmBlocker } from "./llm-credential-service";
import { CRON_FAILURE_DISABLE_THRESHOLD } from "./agent-cron-service";
import {
  ACTIVE_TURN_STATUSES,
  AGENT_RESTARTED_MESSAGE,
  AGENT_START_FAILED_MESSAGE,
  AUTOMATION_SOURCES,
  TURN_FAILURE_COPY,
  type ConversationSource,
  type TurnStatus,
} from "../validations/conversation";
import { logger } from "../lib/logger";
import { stripControl } from "../lib/text";
import {
  attachmentMetaSelect,
  bindAttachmentsToTurn,
  firstAttachmentName,
} from "./attachment-service";

const log = logger.child({ component: "turn-service" });

/**
 * A real type guard rather than `includes(status as never)`: asserting to
 * `never` is the one assertion nothing can ever validate, and it keeps
 * compiling if the column's type changes underneath it.
 */
const isActiveTurnStatus = (
  status: string,
): status is (typeof ACTIVE_TURN_STATUSES)[number] =>
  (ACTIVE_TURN_STATUSES as readonly string[]).includes(status);

/**
 * Turns and the transcript.
 *
 * Two laws live here and are worth stating once:
 *
 * 1. **`seq` comes from the conversation row.** Assigning it with an atomic
 *    increment takes a row lock held to commit, so per conversation the order
 *    events are numbered is the order they become visible. That is what makes
 *    "read history, then tail from the last seq" lossless — a global sequence
 *    would let a lower number commit later and be skipped forever.
 * 2. **The delta law (§3.17).** Everything published reaches live tails;
 *    only bounded kinds are persisted. Streamed text is a rendering artifact,
 *    not a record — storing it would mean thousands of rows to reconstruct
 *    one paragraph.
 */

/**
 * Event kinds that become durable rows. Deliberately excludes `text.delta`
 * and `thinking.delta`: those stream and vanish. `turn.done`/`error` are the
 * terminal markers a reader needs to know a turn ended.
 */
const DURABILITY = {
  "turn.started": true,
  "tool.started": true,
  "tool.finished": true,
  "approval.pending": true,
  "turn.done": true,
  error: true,
  // The answer itself — one coalesced row per turn, emitted by the supervisor
  // just before the terminal event. Without it the transcript records that a
  // turn happened and what it touched, but not a word of what it said.
  text: true,
  // A non-fatal warning about the run itself ("that model isn't available, so
  // this is running the default"). Durable because the condition outlives the
  // turn it appeared in: a reader who refreshes still needs to know why the
  // agent is not running what the settings page says.
  notice: true,
  // Streamed and then gone. Storing them would mean thousands of rows to
  // reconstruct one paragraph.
  "text.delta": false,
  "thinking.delta": false,
  // A control-plane state transition, not transcript content: the follow-up
  // row settling `joined` is the durable record, and `turn.result.followUps`
  // is how it gets there — this event is only the adapter's live confirmation
  // riding the stream.
  "message.joined": false,
  // `satisfies` rather than a Set: a new event kind is then a COMPILE error
  // here until someone decides whether it persists, instead of silently
  // defaulting to "streams but is never recorded".
} as const satisfies Record<AgentEvent["type"], boolean>;

/**
 * U+0000. Built rather than written as an escape, so the byte itself never
 * appears in this source file.
 */
const NUL = String.fromCharCode(0);

/**
 * Strip U+0000 from every string an event carries, however deeply nested.
 *
 * The runner already does this at the source, and this repeats it anyway for
 * the same reason every other runner-supplied value is re-checked here: the
 * control plane does not take a reporter's word for anything. Without it, one
 * NUL byte in a tool output raises inside the transaction, rolls back the
 * whole batch, and loses that stretch of transcript — a self-inflicted outage
 * for that conversation, triggerable by an agent reading a binary file.
 *
 * Sanitized rather than rejected: nobody typed this, and dropping a few bytes
 * beats dropping a minute of the turn.
 */
const withoutNulBytes = <T>(value: T): T => {
  if (typeof value === "string") {
    return (value.includes(NUL) ? value.split(NUL).join("") : value) as T;
  }
  if (Array.isArray(value)) return value.map(withoutNulBytes) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        withoutNulBytes(inner),
      ]),
    ) as T;
  }
  return value;
};

const turnSelect = {
  id: true,
  conversationId: true,
  status: true,
  source: true,
  userId: true,
  message: true,
  error: true,
  errorCode: true,
  usage: true,
  followUpOfTurnId: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
  // Metadata only (attachmentMetaSelect) — bytes never ride a turn payload.
  attachments: {
    select: attachmentMetaSelect,
    orderBy: { createdAt: "asc" as const },
  },
} as const;

/**
 * Post a message. Fails with CONFLICT when the conversation already has a
 * turn in flight — enforced by the `turns_one_active_per_conversation` partial
 * index, so two concurrent posts cannot both win the check.
 *
 * If the agent's sandbox is asleep this also wakes it: the turn sits `queued`
 * until the sandbox reports ready, and the runner's held poll is signalled so
 * neither step waits out a re-check interval.
 */
/** Longest a derived conversation title may be. A rail row, not a summary. */
export const MAX_DERIVED_TITLE_LENGTH = 80;

/**
 * A conversation's label, taken from the message that opened it.
 *
 * Collapses whitespace first, so a pasted stack trace becomes one scannable
 * line rather than a row of ragged newlines, and truncates on a word boundary
 * when there is one to land on.
 */
export const deriveTitle = (message: string): string | null => {
  const flat = message.replace(/\s+/g, " ").trim();
  // A message may legally be nothing but whitespace — `min(1)` counts a space.
  // Storing the empty string that collapses to would be worse than storing
  // nothing: null is a missing title the reader can fall back on, `""` is a
  // title that renders as a blank row.
  if (!flat) return null;
  if (flat.length <= MAX_DERIVED_TITLE_LENGTH) return flat;
  const cut = flat.slice(0, MAX_DERIVED_TITLE_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  // Only break on a word if that keeps most of the line — otherwise a single
  // very long token would leave a stub.
  return `${lastSpace > MAX_DERIVED_TITLE_LENGTH * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
};

/**
 * Where a turn came from and who spoke — stamped by the door that created it,
 * never chosen by the client. `source` is what mirroring keys echo-suppression
 * on and what the web renders an origin chip from; `userId` is the speaker
 * (the thread owner on a direct thread, the per-turn speaker on a group one).
 * The same identity doubles as the privacy-fence viewer, so a caller cannot
 * write into a direct thread they could not read.
 */
export interface TurnOrigin {
  source: ConversationSource;
  /**
   * The speaker — or `null` for a turn the PLATFORM creates (a cron fire,
   * step 7; watch fires). Null is not "anonymous": it routes through
   * `requireSystemConversation`, which fences by workspace and refuses direct
   * threads outright — the platform speaks only into sourced conversations,
   * never into someone's private thread through this door.
   */
  userId: string | null;
  /**
   * The ONE sanctioned exception to the direct-thread refusal above: a watch
   * wake running in the direct conversation the watched work belongs to, so
   * the report is the turn itself. Honored only with `userId: null`, routed
   * through `requireDirectWakeConversation` (agent + direct fences in the
   * WHERE), and stamped exclusively by watch-fire-service after its
   * creator/owner check — no route ever populates TurnOrigin from a client.
   */
  directWake?: { agentId: string };
  /**
   * WHERE the message arrived, when the door's surface addresses finer than
   * its thread link does (Slack: the DM thread the person typed in). Stored
   * on the turn so the completion pass can answer THERE — a DM link resolves
   * one address for every thread inside it, so without this the answer to a
   * threaded question lands at the bottom of the DM.
   *
   * Provider-opaque and door-stamped: like `source` and `userId`, an ingest
   * door derives it from the provider's own event, never from client input.
   */
  sourceThreadId?: string | null;
}

/**
 * Create a turn row, binding its attachments in the SAME transaction when the
 * message carries any. The plain path (no attachments — every turn today,
 * every automation turn always) stays a single insert; the attachment path
 * pays one interactive transaction and re-reads the row so the returned
 * payload already carries its attachment metadata (the web inserts it into
 * the turns cache directly).
 */
const createTurnRowWithAttachments = async (
  data: {
    conversationId: string;
    message: string;
    status: string;
    source: ConversationSource;
    userId: string | null;
    followUpOfTurnId?: string;
  },
  origin: TurnOrigin,
  attachmentIds?: string[],
) => {
  // The arrival address rides with EVERY turn row, stamped here rather than
  // at the two call sites: `createTurn` and `createFollowUp` share this
  // builder, and a threaded follow-up must answer in the same thread its
  // parent did — a divergence between them would post one exchange's halves
  // to two different places.
  const row = {
    ...data,
    ...(origin.sourceThreadId != null && {
      sourceThreadId: origin.sourceThreadId,
    }),
  };
  if (!attachmentIds || attachmentIds.length === 0) {
    return db.turn.create({ data: row, select: turnSelect });
  }
  return db.$transaction(async (tx) => {
    const turn = await tx.turn.create({ data: row, select: { id: true } });
    await bindAttachmentsToTurn(tx, {
      conversationId: data.conversationId,
      turnId: turn.id,
      userId: origin.userId,
      attachmentIds,
    });
    return tx.turn.findUniqueOrThrow({
      where: { id: turn.id },
      select: turnSelect,
    });
  });
};

export const createTurn = async (
  workspaceId: string,
  conversationId: string,
  message: string,
  origin: TurnOrigin,
  attachmentIds?: string[],
) => {
  const conversation =
    origin.userId === null
      ? origin.directWake
        ? await requireDirectWakeConversation(
            workspaceId,
            conversationId,
            origin.directWake.agentId,
          )
        : await requireSystemConversation(workspaceId, conversationId)
      : await requireConversation(workspaceId, conversationId, origin.userId);

  try {
    // The turn row and its attachment binds commit TOGETHER: `signalWork()`
    // below fires before this function returns, and both the dispatch
    // composer and the steer arm's carve-out read the attachment table — a
    // turn observable without its rows would ship bare, silently. A bind
    // that cannot complete aborts the transaction: no turn row, honest 422.
    const turn = await createTurnRowWithAttachments(
      {
        conversationId: conversation.id,
        // The human's EXACT words, stored verbatim. Platform framing — the
        // continuity bridge (step 7) and memory (step 8) — rides the
        // delivery-only `context` channel (turn-context-service), never this
        // stored message, so the chat and the Slack mirror render what the
        // person actually typed rather than the model-facing prompt.
        message,
        status: "queued",
        source: origin.source,
        userId: origin.userId,
      },
      origin,
      attachmentIds,
    );

    // Name the conversation after the message that opened it. Without this
    // every row in a reader's history reads "New conversation" — the list is
    // there to be scanned, and an unlabelled list cannot be. Only ever fills a
    // NULL: a title set by its source (a Slack thread subject, a cron's name)
    // or by a human is never overwritten by a later message. Direct threads
    // stay untitled (§3.18: the agent is the name; nothing renders a title
    // for them) — deriving one would be a write nothing reads. A file-only
    // opener falls back to its first attachment's name (an unlabelled row is
    // a write nothing reads, and "" derives to null).
    const title =
      !conversation.direct && conversation.title === null
        ? (deriveTitle(message) ?? (await firstAttachmentName(turn.id)))
        : null;
    if (title !== null) {
      await db.conversation.updateMany({
        where: { id: conversation.id, title: null },
        data: { title },
      });
    }

    // DOOR 1 of the §3.2 credential check: answer the thread.
    //
    // The turn row above is created FIRST and `queued`, deliberately. The
    // user's message belongs in the transcript whatever happens next, and
    // `queued` is what makes a concurrent second send lose on
    // `turns_one_active_per_conversation` and get the 409 below — creating it
    // `failed` would let two keyless sends both win.
    //
    // Moving it straight to a terminal `failed` releases that partial index,
    // so the next send is not a 409 either.
    const blocker = await findAgentLlmBlocker(
      workspaceId,
      conversation.agentId,
    );
    if (blocker) {
      // Neither wake NOR signal: the start arm claims a parked sandbox because
      // a queued/dispatched turn EXISTS, and this one no longer is — so waking
      // a poll here would only spend a cycle finding nothing.
      return await db.turn.update({
        where: { id: turn.id },
        data: {
          status: "failed",
          error: blocker.message,
          errorCode: blocker.code,
          finishedAt: new Date(),
        },
        select: turnSelect,
      });
    }

    await wakeSandboxFor(conversation.agentId);
    // Wake any held runner poll so a queued turn dispatches now rather than
    // after the next re-check.
    signalWork();

    return turn;
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ServiceError(
        "CONFLICT",
        "This conversation already has a turn in progress",
      );
    }
    throw err;
  }
};

/**
 * Promote the oldest parked follow-up of a conversation into an ordinary
 * queued turn — the same row, in place, so the message keeps its identity
 * (and its Slack receipt) across the transition.
 *
 * The partial unique index is the arbiter exactly as it is for `createTurn`:
 * flipping `joining` → `queued` while ANY active turn exists raises P2002,
 * and losing that race is an answer, not an error — whoever won now occupies
 * the conversation, and this row's next chance is that turn's close (or the
 * poll backstop). The tail mimics `createTurn`'s: a parked sandbox is woken
 * (a `failed` one would otherwise wait out the 30s retry pacing) and the held
 * poll is signalled.
 *
 * `promotedAt` restarts the ceiling clock: a follow-up parked late in a long
 * turn must get a full turn's budget of its own, not the target's remainder.
 */
export const promoteOldestParkedFollowUp = async (
  conversationId: string,
): Promise<boolean> => {
  const oldest = await db.turn.findFirst({
    where: { conversationId, status: "joining" },
    orderBy: { createdAt: "asc" },
    select: { id: true, conversation: { select: { agentId: true } } },
  });
  if (!oldest) return false;

  try {
    const { count } = await db.turn.updateMany({
      // The status guard makes a concurrent settle/abort of this same row a
      // clean no-op rather than a resurrection.
      where: { id: oldest.id, status: "joining" },
      data: { status: "queued", promotedAt: new Date() },
    });
    if (count === 0) return false;
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return false; // a racing send won the index — its turn runs first
    }
    throw err;
  }

  await wakeSandboxFor(oldest.conversation.agentId);
  signalWork();
  return true;
};

/**
 * THE COLD-DEATH REVIVAL (plans/v2-todo.md "cold-boot auto-retry"): flip a
 * dispatched turn whose harness died before ANY observable work back to
 * `queued`, in place, exactly once — the ordinary delivery machinery then
 * re-runs it on a fresh container, invisibly.
 *
 * The predicate is the whole safety argument. Promotion to `running` happens
 * ONLY when the harness's `turn.started` event lands (`applyTurnEvents`), so
 * `dispatched` + `startedAt IS NULL` means nothing OBSERVABLE ever happened —
 * honest up to event delivery: the runner's event posts are paced and
 * fire-and-forget, so a death in the sub-second window between the harness
 * starting and its `turn.started` batch landing re-runs a turn that had, at
 * most, just begun (a side effect needs a tool call, seconds later — and the
 * once-fence caps even that residue at one re-run). A turn that reached
 * `running` NEVER matches: its death must stay visible. `retriedAt` is the
 * once-fence: set on the first revival, checked by the next, never cleared.
 *
 * In place, never a clone: attachments, the Slack receipt, and the
 * conversation's ordering all key on this row — and the row never passes
 * through a terminal status, so the web's poll cannot flash an error and the
 * Slack mirror (which posts any terminal turn past its cursor) cannot
 * double-post.
 *
 * No P2002 catch, deliberately unlike `promoteOldestParkedFollowUp` above:
 * this row already holds the conversation's active slot in the partial
 * unique index (`dispatched` is in its WHERE), and `dispatched → queued`
 * neither changes the indexed key nor moves the row in or out of the
 * predicate. Do not "fix" this to match the template.
 *
 * Applied only to DEATH-classified FAILED outcomes, and only by the
 * sandbox-death doors (`finishTurn` gated on the death codes,
 * `applyRunnerEvent`, `requestSandboxRespawn`) — an abort is a human
 * decision and a `done` is an answer; neither is ever re-run.
 *
 * NO wake/signal here: callers own that, and the two death-report orders
 * recover differently. Stopped-first: the strand door revives, flips the
 * dead sandbox to `unprovisioned`, and signals — a fresh boot NOW.
 * Finished-first: this door revives but deliberately does NOT signal (the
 * sandbox may still read `running` for the instant before its own death
 * report lands, and a signal would hand the revived turn straight back to
 * the dying container, burning the fence); the batch's following `stopped`
 * report then finds nothing left to revive and doesn't wake either — the
 * poll loop's ~1s re-check claims the stopped sandbox off its queued turn
 * instead. Correct in both orders; only the wake latency differs.
 */
export const reviveColdTurns = async (
  tx: Prisma.TransactionClient,
  where: Prisma.TurnWhereInput,
): Promise<number> => {
  const { count } = await tx.turn.updateMany({
    where: {
      ...where,
      status: "dispatched",
      startedAt: null,
      retriedAt: null,
    },
    data: { status: "queued", retriedAt: new Date() },
  });
  return count;
};

/**
 * The terminal half of the strand law: fail the in-flight turns a dead
 * sandbox leaves behind, with copy that tells the truth PER TURN — one that
 * never started (its one revival already spent) could not have done anything
 * and gets the start-failed sentence; one that ran gets the restarted
 * sentence and its "check what it finished" caution. One definition, used by
 * both sandbox-death doors (`applyRunnerEvent`, `requestSandboxRespawn`) and
 * matching `finishTurn`'s code-mapped copy, so both death-report orders
 * converge on identical words for the identical failure. Runs AFTER
 * `reviveColdTurns` in the same transaction — order matters: what this sees
 * as dispatched-never-started is exactly the revival-spent remainder.
 */
export const failStrandedTurns = async (
  tx: Prisma.TransactionClient,
  where: Prisma.TurnWhereInput,
): Promise<number> => {
  const finishedAt = new Date();
  const { count: neverStarted } = await tx.turn.updateMany({
    where: { ...where, status: "dispatched", startedAt: null },
    data: {
      status: "failed",
      error: AGENT_START_FAILED_MESSAGE,
      errorCode: "agent_start_failed",
      finishedAt,
    },
  });
  const { count: started } = await tx.turn.updateMany({
    where: { ...where, status: { in: ["dispatched", "running"] } },
    data: {
      status: "failed",
      error: AGENT_RESTARTED_MESSAGE,
      errorCode: "agent_restarted",
      finishedAt,
    },
  });
  return neverStarted + started;
};

/**
 * Record a mid-run follow-up: the message rides its own Turn row in the
 * non-active `joining` status, targeting the turn it should steer into.
 * No sandbox wake — the target turn already holds the box up — but the poll
 * IS signalled so the steer dispatch arm claims it now, not next re-check.
 *
 * Deliberately NOT `createTurn`: no title derivation (the conversation is
 * already named), no door-1 credential check (the target turn passed it),
 * and no partial-index exposure (`joining` is outside its WHERE).
 */
export const createFollowUp = async (
  conversationId: string,
  targetTurnId: string,
  message: string,
  origin: TurnOrigin,
  attachmentIds?: string[],
) => {
  // Bind-in-transaction matters MOST here: the steer arm's carve-out ("an
  // attachment-carrying follow-up never steers") reads the attachment table,
  // and `signalWork()` races it — a follow-up observable before its rows
  // would steer text-only and orphan the files on a `joined` row forever
  // (steers are at-most-once).
  const followUp = await createTurnRowWithAttachments(
    {
      conversationId,
      message,
      status: "joining",
      followUpOfTurnId: targetTurnId,
      source: origin.source,
      userId: origin.userId,
    },
    origin,
    attachmentIds,
  );
  signalWork();
  return followUp;
};

/** How much of a delivered report the continuity bridge repeats. */
const BRIDGE_EXCERPT_MAX_CHARS = 500;
/** How many recent reports one bridge note may carry. */
const BRIDGE_MAX_REPORTS = 3;
/**
 * How much of a delivery's own message survives as the note's LABEL.
 * A headline's worth: enough to name the automation, short enough that the
 * report stays the thing being read.
 */
const BRIDGE_LABEL_MAX_CHARS = 120;

/**
 * The one-line label naming an automation in a bridge note.
 *
 * `turn.message` is NOT reliably a short header. It is one for a delivery
 * materialized by the settle chain (`Watch on "x"` / `Scheduled run "x"`),
 * but an IN-ORIGIN wake (watch-fire-service's `fireBucket`) stores the whole
 * `buildConsolidatedWakeMessage` prompt — platform header, every watch's task
 * text, and its output excerpt. Relaying that verbatim replayed a full
 * instruction block into the next human turn, which the model then answered
 * as work still owed (live, 2026-08-31).
 *
 * First line, bounded — the same treatment the Slack mirror gives an
 * automation caption, for the same reason.
 */
const bridgeLabel = (message: string): string => {
  // \r too: a CRLF header would otherwise carry a stray carriage return.
  const firstLine =
    stripControl(message)
      .split(/[\r\n]/, 1)[0]
      ?.trim() ?? "";
  if (firstLine.length <= BRIDGE_LABEL_MAX_CHARS) return firstLine;
  // Never cut between a surrogate pair — the tail would render as U+FFFD.
  return `${firstLine
    .slice(0, BRIDGE_LABEL_MAX_CHARS)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trimEnd()}…`;
};

/**
 * The continuity bridge (step 7). A scheduled/watched run executes in ITS OWN
 * conversation and only a finished report lands here — so this conversation's
 * harness session has never seen it. When the human's next message follows
 * such a delivery, the agent needs what arrived so "what was that number you
 * just sent?" has a referent.
 *
 * It rides the delivery-only `context` channel (turn-context-service), NOT
 * the stored message — the human's turn.message stays their exact words. This
 * returns just the bridge BLOCK (bounded, sanitized) for the composer to
 * prepend to the model input, or null when nothing landed since the last
 * human turn. `before` bounds the window to this turn's own moment, since it
 * is composed at dispatch (the turn already exists) rather than at creation.
 */
export const buildContinuityBridge = async (
  conversationId: string,
  before: Date,
): Promise<string | null> => {
  // The sender's frame of reference: deliveries since the last human-visible
  // exchange, up to this turn. One indexed lookup; conversations with no
  // deliveries pay only this. Both automation sources (cron + watch) count.
  const lastHumanTurn = await db.turn.findFirst({
    where: {
      conversationId,
      source: { notIn: [...AUTOMATION_SOURCES] },
      createdAt: { lt: before },
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const deliveries = await db.turn.findMany({
    where: {
      conversationId,
      source: { in: [...AUTOMATION_SOURCES] },
      // COMPLETED runs only. A failed automation produced no report — its
      // `text` event never landed — so relaying it sent the model the run's
      // own INSTRUCTION with an empty body, which reads as work still owed
      // and gets answered in the next human turn (live, 2026-08-31). There
      // is no "context from your automated runs" in a run that did not run.
      status: "done",
      createdAt: {
        lt: before,
        ...(lastHumanTurn && { gt: lastHumanTurn.createdAt }),
      },
    },
    orderBy: { createdAt: "desc" },
    take: BRIDGE_MAX_REPORTS,
    select: { id: true, message: true },
  });
  if (deliveries.length === 0) return null;

  const texts = await db.turnEvent.findMany({
    where: { turnId: { in: deliveries.map((d) => d.id) }, type: "text" },
    select: { turnId: true, payload: true },
  });
  const textOf = new Map(
    texts.map((event) => [
      event.turnId,
      String((event.payload as { text?: unknown } | null)?.text ?? ""),
    ]),
  );

  const notes = deliveries
    .reverse()
    .map((delivery) => ({
      delivery,
      body: stripControl(textOf.get(delivery.id) ?? "").trim(),
    }))
    // A `done` run that said nothing has no report to relay. Without this,
    // its label would ride alone — a bare instruction line, the same shape
    // the status filter above exists to keep out.
    .filter(({ body }) => body !== "")
    .map(({ delivery, body }) => {
      const excerpt =
        body.length > BRIDGE_EXCERPT_MAX_CHARS
          ? `${body.slice(0, BRIDGE_EXCERPT_MAX_CHARS)}…`
          : body;
      // The delivery's message NAMES the automation — but only its first,
      // bounded line: an in-origin wake stores its whole prompt there. See
      // `bridgeLabel`. Still platform-authored either way, so nothing the
      // model wrote is trusted here.
      return `${bridgeLabel(delivery.message)}\n${excerpt}`;
    })
    .join("\n\n");
  // Every delivery in the window was silent — nothing to bridge.
  if (!notes) return null;

  return `[Context from your automated runs — delivered to this chat since the last message; the person may be referring to it:]\n${notes}\n[End of automated-run context]`;
};

/** How much of the agent's own last reply the wake reminder repeats. */
const OPEN_PROMISE_EXCERPT_MAX_CHARS = 400;

/**
 * What the agent last told the person, for a wake to answer against.
 *
 * A wake arrives with the platform's own instruction ("report what these
 * background tasks did") and nothing else. That is the whole conversation
 * the model sees, so an agent that told someone "I'll post the rankings
 * once all five finish" answers the question it was ASKED — "did anything
 * go wrong?" — reports that nothing did, and never delivers the thing it
 * promised. Observed live 2026-09-01.
 *
 * So the wake carries the agent's own most recent reply back to it. Not an
 * inference about intent, not a reconstruction of the thread: one bounded
 * excerpt of what it actually said, which is the only place an outstanding
 * promise can be read from without guessing.
 *
 * Returns null when there is no prior reply — a first-contact wake has no
 * promise to keep, and a bare label would be noise.
 */
export const buildOpenPromiseNote = async (
  conversationId: string,
  before: Date,
): Promise<string | null> => {
  const lastHumanTurn = await db.turn.findFirst({
    where: {
      conversationId,
      source: { notIn: [...AUTOMATION_SOURCES] },
      createdAt: { lt: before },
      status: "done",
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!lastHumanTurn) return null;

  // The turn's OWN answer — the coalesced `text` row, the same one the
  // channel posts. `desc` because a turn's last text is its answer.
  const answer = await db.turnEvent.findFirst({
    where: { turnId: lastHumanTurn.id, type: "text" },
    orderBy: { seq: "desc" },
    select: { payload: true },
  });
  const body = stripControl(
    String((answer?.payload as { text?: unknown } | null)?.text ?? ""),
  ).trim();
  if (body === "") return null;

  const excerpt =
    body.length > OPEN_PROMISE_EXCERPT_MAX_CHARS
      ? `${body.slice(0, OPEN_PROMISE_EXCERPT_MAX_CHARS)}…`
      : body;
  return `[Your last reply in this chat, for reference — if it promised something once this work finished, deliver it now rather than only reporting the runs:]\n${excerpt}\n[End of your last reply]`;
};

/**
 * A parked sandbox must come back before its turn can run. Only `stopped` and
 * `failed` are woken — never `running`/`starting`, which would tear down a
 * container that is already on its way. Exported for the SSH front door
 * (step 5): session-open and cert-mint ride the same flip; the corresponding
 * poll-time dueness arms in due-work.ts keep both honest if the flip races.
 */
export const wakeSandboxFor = async (agentId: string): Promise<void> => {
  await db.sandbox.updateMany({
    where: { agentId, status: { in: ["stopped", "failed"] } },
    data: { status: "unprovisioned" },
  });
};

export const listTurns = async (
  workspaceId: string,
  conversationId: string,
  viewerUserId: string,
) => {
  await requireConversation(workspaceId, conversationId, viewerUserId);
  return db.turn.findMany({
    where: { conversationId },
    select: turnSelect,
    orderBy: { createdAt: "asc" },
    take: 200,
  });
};

/**
 * Ask for a turn to stop. The turn is marked `aborted` only once the sandbox
 * confirms; here it is flagged so the dispatcher carries the abort down. A
 * turn that never reached a sandbox (`queued`) can be abandoned outright.
 */
export const abortTurn = async (
  workspaceId: string,
  turnId: string,
  viewerUserId: string,
) => {
  // Two attempts, because every arm below is a guarded write racing the
  // turn's own lifecycle (promotion flips joining→queued, dispatch flips
  // queued→dispatched). A guard miss means the row moved between the read
  // and the write — re-read and dispatch to the arm that NOW matches, so a
  // cancel is never reported for a write that changed nothing.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // The privacy fence rides turn → conversation → owner: aborting is a
    // write into the thread, so a foreign direct thread's turn reads
    // NOT_FOUND.
    const turn = await db.turn.findFirst({
      where: {
        id: turnId,
        conversation: {
          agent: { workspaceId },
          OR: [{ direct: false }, { userId: viewerUserId }],
        },
      },
      select: { id: true, status: true, conversationId: true },
    });
    if (!turn) throw new ServiceError("NOT_FOUND", "Turn not found");

    if (turn.status === "joining") {
      // A parked follow-up: neither finished nor unabortable. The status
      // guard makes this race-safe against a concurrent settle or promotion
      // — a miss re-reads instead of claiming success for a no-op.
      const { count } = await db.turn.updateMany({
        where: { id: turn.id, status: "joining" },
        data: { status: "aborted", finishedAt: new Date() },
      });
      if (count === 0) continue;
      return { aborted: true, delivered: false };
    }

    if (!isActiveTurnStatus(turn.status)) {
      throw new ServiceError("CONFLICT", "This turn has already finished");
    }

    // Stop means silence (decided with the user): aborting the active turn
    // also cancels every follow-up still steering toward it. Swept here at
    // request time, and again on the aborted close (`finishTurn`) for any
    // follow-up that lands in the request→confirm window.
    const sweepFollowUps = () =>
      db.turn.updateMany({
        where: { conversationId: turn.conversationId, status: "joining" },
        data: { status: "aborted", finishedAt: new Date() },
      });

    if (turn.status === "queued") {
      // Never dispatched — nothing to tell the sandbox about.
      const { count } = await db.turn.updateMany({
        where: { id: turn.id, status: "queued" },
        data: { status: "aborted", finishedAt: new Date() },
      });
      if (count === 0) continue; // dispatched under us — the flag arm owns it
      await sweepFollowUps();
      return { aborted: true, delivered: false };
    }

    // In flight: the runner picks up the abort on its next poll, which the
    // signal wakes immediately. If the turn went terminal under us, the flag
    // is either inert (`done`/`aborted` — the claim arm never reads those) or
    // exactly right (`failed` — the claim arm's failed leg exists to stop a
    // sweep-killed turn's still-working sandbox, which is also what this
    // race left behind).
    await db.turn.update({
      where: { id: turn.id },
      data: { abortRequested: true },
    });
    await sweepFollowUps();
    signalWork();
    return { aborted: false, delivered: true };
  }

  // Two straight guard misses: the row is churning through its lifecycle
  // faster than this cancel can land — by now it is dispatched or terminal,
  // and the honest answer is the in-flight shape (the flag write above) or
  // the retry the user will make.
  throw new ServiceError("CONFLICT", "This turn has already finished");
};

/**
 * THE REPORTER FENCE — two authenticated facts, both required.
 *
 * A report names the conversation and turn it concerns, and BOTH of those ids
 * are chosen by the sandbox, which runs model-driven code and is the least
 * trusted thing in the system. Only two parts of an incoming report are
 * actually authenticated: the `rnr_` token identifies the runner, and the
 * control channel identifies the sandbox. So the fence is expressed in terms
 * of exactly those two, in the `where`:
 *
 *   this turn's conversation's agent owns THIS sandbox, and it sits on THIS
 *   runner.
 *
 * Without the runner half, any `rnr_` token could write into any tenant's
 * transcript. Without the sandbox half, any one sandbox could forge turns for
 * every other conversation on its runner — which in a single-runner install is
 * every tenant. `Sandbox.agentId` is `@unique`, so this resolves to at most one
 * row and "the agent that owns this sandbox" is exact.
 */
const turnBelongsToReporter = async (
  tx: Prisma.TransactionClient,
  reporter: ReporterIdentity,
  conversationId: string,
  turnId: string,
): Promise<boolean> => {
  const turn = await tx.turn.findFirst({
    where: {
      id: turnId,
      conversationId,
      conversation: {
        agent: {
          sandbox: { id: reporter.sandboxId, runnerId: reporter.runnerId },
        },
      },
    },
    select: { id: true },
  });
  return turn !== null;
};

/**
 * Who is reporting, as established by authentication — never by the payload.
 * `runnerId` comes from the runner's bearer token, `sandboxId` from the
 * WebSocket the supervisor authenticated on.
 */
export interface ReporterIdentity {
  runnerId: string;
  sandboxId: string;
}

/**
 * Persist and fan out a batch of events from a running turn.
 *
 * `seq` is allocated by incrementing the conversation counter once for the
 * whole batch, inside the same transaction that writes the rows — so numbers
 * are contiguous, and a rollback takes them back with it.
 *
 * Returns whether the batch was ACCEPTED. A rejected batch is ignored rather
 * than thrown (a dying sandbox's rescue events must still land), so the
 * verdict is the only signal a caller has.
 */
export const applyTurnEvents = async (
  reporter: ReporterIdentity,
  conversationId: string,
  turnId: string,
  events: AgentEvent[],
): Promise<boolean> => {
  if (events.length === 0) return true;

  // Sanitized BEFORE the transaction opens: it is a deep walk over every
  // event in the batch, including the text deltas that are never stored, and
  // it depends on nothing inside. Doing it under the conversation row lock
  // would serialize that CPU against the whole conversation, on the hottest
  // write path in the system.
  const clean = events.map(withoutNulBytes);

  const published = await db.$transaction(async (tx) => {
    if (!(await turnBelongsToReporter(tx, reporter, conversationId, turnId))) {
      log.warn(
        { ...reporter, conversationId, turnId },
        "ignoring turn events from a sandbox that does not host this turn",
      );
      return null;
    }

    // The row lock this takes is what makes seq order == commit order.
    const { lastSeq } = await tx.conversation.update({
      where: { id: conversationId },
      data: { lastSeq: { increment: events.length } },
      select: { lastSeq: true },
    });

    const firstSeq = lastSeq - clean.length + 1;
    const numbered: PublishedEvent[] = clean.map((event, index) => ({
      seq: firstSeq + index,
      turnId,
      type: event.type,
      event,
    }));

    const durable = numbered.filter((entry) => DURABILITY[entry.event.type]);
    if (durable.length > 0) {
      await tx.turnEvent.createMany({
        data: durable.map((entry) => ({
          conversationId,
          turnId,
          seq: entry.seq,
          type: entry.type,
          payload: entry.event as unknown as Prisma.InputJsonValue,
        })),
      });
    }

    // `turn.started` is the sandbox saying the model is actually working, as
    // opposed to `dispatched` (handed over, maybe still booting). Recording it
    // here rather than over a separate wire message keeps one signal doing one
    // job — and it is what gives `startedAt` a value.
    if (events.some((event) => event.type === "turn.started")) {
      await tx.turn.updateMany({
        where: { id: turnId, status: "dispatched" },
        data: { status: "running", startedAt: new Date() },
      });
    }

    // A turn producing events is a live conversation: keep the idle reaper
    // away from a sandbox that is mid-answer.
    // By primary key: the fence above already proved this sandbox hosts the
    // turn, so walking agent → conversations → some(id) would be a
    // three-level correlated subquery to reach a row we already have.
    await tx.sandbox.updateMany({
      where: { id: reporter.sandboxId },
      data: { lastActiveAt: new Date() },
    });

    return numbered;
  });

  // Publish AFTER commit: a subscriber must never see an event that a
  // rollback un-happened, and never one the fence rejected.
  if (published) getEventBus().publish(conversationId, published);
  // `null` is the fence's own verdict (the transaction above returns it when
  // the reporter does not host this turn). Returned rather than swallowed
  // because a caller acting on the SAME events — the channel narration in
  // routes/runner.ts — must not act on a batch the transcript rejected, or
  // one tenant's sandbox could drive another tenant's Slack thread.
  return published !== null;
};

/**
 * Stamp the turn-liveness clock from a supervisor heartbeat.
 *
 * One fenced write: the turn must be RUNNING and belong to the authenticated
 * reporter (the same two facts as `turnBelongsToReporter`, folded into the
 * `where` so the stamp and the fence are one statement). The status guard is
 * load-bearing twice over — a heartbeat for a turn a sweep already failed is
 * an orphan's, and an orphan must move neither the stall clock nor the idle
 * clock — which is why `sandbox.lastActiveAt` is stamped only when the turn
 * row matched.
 */
export const applyTurnProgress = async (
  reporter: ReporterIdentity,
  conversationId: string,
  turnId: string,
): Promise<void> => {
  const { count } = await db.turn.updateMany({
    where: {
      id: turnId,
      conversationId,
      status: "running",
      conversation: {
        agent: {
          sandbox: { id: reporter.sandboxId, runnerId: reporter.runnerId },
        },
      },
    },
    data: { lastProgressAt: new Date() },
  });
  if (count === 0) return;
  await db.sandbox.updateMany({
    where: { id: reporter.sandboxId },
    data: { lastActiveAt: new Date() },
  });
};

export interface FinishTurnInput {
  /** The authenticated reporter — the fence, never trusted from the payload. */
  reporter: ReporterIdentity;
  conversationId: string;
  turnId: string;
  status: Extract<TurnStatus, "done" | "failed" | "aborted">;
  error?: string;
  /** The wire failure class (an open string from the sandbox/runner). Only
   * values in `TURN_FAILURE_COPY` mean anything; the rest are ignored. */
  errorCode?: string;
  usage?: TurnUsage;
  sessionRef?: string;
  /** Per-follow-up steer outcomes from the sandbox's terminal report. */
  followUps?: { turnId: string; outcome: "joined" | "missed" }[];
}

/**
 * The canonical `{code, message}` for a failed report's wire code, when the
 * allowlist knows it. A known class closes with the CANONICAL copy — the raw
 * error string is operator material (finishTurn logs it), never shown to a
 * person. A code the allowlist does not know (or an old supervisor that sent
 * none) keeps today's raw passthrough. `hasOwn`, not a bare index: the code
 * is a peer-supplied string, and "__proto__"/"constructor" would otherwise
 * resolve to truthy prototype members and mis-take the branch.
 */
const knownFailureCopy = (
  input: Pick<FinishTurnInput, "status" | "errorCode">,
): (typeof TURN_FAILURE_COPY)[string] =>
  input.status === "failed" &&
  Object.hasOwn(TURN_FAILURE_COPY, input.errorCode ?? "")
    ? TURN_FAILURE_COPY[input.errorCode ?? ""]
    : undefined;

/**
 * Close out a turn. Also persists the conversation's harness session ref —
 * the sandbox is the only place that knows it, and without it every turn
 * would start a fresh context instead of resuming.
 *
 * Reporter-fenced like every other sandbox-driven write. `sessionRef` makes
 * that load-bearing rather than tidy: it is the handle the NEXT turn resumes
 * from, so an unfenced write here would let one sandbox point another tenant's
 * conversation at a harness session it controls.
 */
export const finishTurn = async (input: FinishTurnInput): Promise<void> => {
  const reporterFence = {
    conversation: {
      agent: {
        sandbox: {
          id: input.reporter.sandboxId,
          runnerId: input.reporter.runnerId,
        },
      },
    },
  } as const;

  const known = knownFailureCopy(input);

  // Only a DEATH-classified failure may revive. The supervisor/runner attach
  // these codes exactly when the harness or its channel died; an ordinary
  // pre-stream failure on a LIVE harness (a stale resume ref) is
  // deterministic — reviving it would run it twice, delay the real error by
  // a full dispatch round-trip, and skip a cron's settle for a non-death.
  // Old-peer degrade: an uncoded HARNESS death still revives — the
  // supervisor sends `unhealthy` before the dying turn's result, so the
  // strand door (state-keyed) gets there first; an old runner's uncoded
  // synthetic channel-loss failure closes as it does today.
  const deathReport =
    input.status === "failed" &&
    (input.errorCode === TURN_FAILURE_CODES.agentStartFailed ||
      input.errorCode === TURN_FAILURE_CODES.agentRestarted);

  const { revived, count } = await db.$transaction(async (tx) => {
    // THE REVIVAL DOOR: a death report for a turn the harness never started
    // re-queues it invisibly instead of closing it (see `reviveColdTurns` for
    // the whole safety argument). Checked FIRST, inside the same transaction,
    // so the close below can never race it; the reporter fence rides the
    // where so this door proves the same ownership the close would.
    if (deathReport) {
      const revivedCount = await reviveColdTurns(tx, {
        id: input.turnId,
        conversationId: input.conversationId,
        ...reporterFence,
      });
      if (revivedCount > 0) return { revived: true, count: 0 };
    }

    const result = await tx.turn.updateMany({
      where: {
        id: input.turnId,
        conversationId: input.conversationId,
        // Only a turn that is still OPEN can be closed. Without this a late
        // duplicate report — the stale-dispatch window can hand the same turn
        // over twice — overwrites a finished one, and the case that matters
        // is `aborted` being replaced by `done`: the user cancelled, and the
        // record says it completed.
        //
        // A FAILED close narrows further, to dispatched/running: nothing
        // ever hands a `queued` turn to a sandbox, so a failed report naming
        // one is stale by definition — and the one path back to
        // queued-after-dispatch is the revival above, which the dying boot's
        // own late `turn.result` (the supervisor sends `unhealthy` first)
        // must find inert. This narrowing is what makes both death-report
        // orders converge on exactly one revival.
        status: {
          in:
            input.status === "failed"
              ? ["dispatched", "running"]
              : (ACTIVE_TURN_STATUSES as unknown as string[]),
        },
        ...reporterFence,
      },
      data: {
        status: input.status,
        error: known?.message ?? input.error ?? null,
        ...(known && { errorCode: known.code }),
        ...(input.usage && {
          usage: input.usage as unknown as Prisma.InputJsonValue,
        }),
        finishedAt: new Date(),
      },
    });

    // Same transaction as the close, deliberately. Two statements would leave
    // a window where the turn is finished but the session ref is not written
    // — and the runner never retries a failed report — so the conversation
    // would silently lose its resume handle and every later turn would start
    // a fresh context. The same window also lets a fast follow-up message
    // dispatch with `resumeSessionRef: null` and lose the thread.
    if (result.count > 0 && input.sessionRef) {
      await tx.conversation.updateMany({
        where: { id: input.conversationId },
        data: { harnessSessionRef: input.sessionRef },
      });
    }

    // Settle steered follow-ups — same transaction, and ONLY when the close
    // won: the stale-dispatch window can hand a turn out twice, and a late
    // duplicate's outcomes must not overrule the winning report's. Every
    // clause of the where is load-bearing: the conversation + target binding
    // reuses the reporter fence the close just proved; `status: "joining"`
    // means an abort that won the race sticks; `steerDeliveredAt` non-null
    // means "joined" is only reachable through a claim the control plane
    // itself stamped — a sandbox cannot swallow messages that were never
    // delivered to it. Missed outcomes need no write: anything left
    // `joining` after the close is the promotion path's to run.
    if (result.count > 0) {
      const joinedIds = (input.followUps ?? [])
        .filter((entry) => entry.outcome === "joined")
        .map((entry) => entry.turnId);
      if (joinedIds.length > 0) {
        await tx.turn.updateMany({
          where: {
            id: { in: joinedIds },
            conversationId: input.conversationId,
            followUpOfTurnId: input.turnId,
            status: "joining",
            steerDeliveredAt: { not: null },
          },
          data: { status: "joined", finishedAt: new Date() },
        });
      }

      // Stop means silence: an aborted close also cancels follow-ups that
      // landed in the abort's request→confirm window. After the settle, so
      // a genuinely-consumed follow-up stays `joined` (the injection
      // happened; the discarded answer is the abort's normal cost).
      if (input.status === "aborted") {
        await tx.turn.updateMany({
          where: { conversationId: input.conversationId, status: "joining" },
          data: { status: "aborted", finishedAt: new Date() },
        });
      }
    }
    return { revived: false, count: result.count };
  });

  if (revived) {
    // Invisible on purpose: no terminal write happened, so nothing else may
    // run — no session-ref persist (the dead boot's ref resumes nothing), no
    // follow-up settle or promotion (the conversation is NOT free; the same
    // turn will run again), and above all no automation settle — a revived
    // cron run must not count a failure strike. The raw error lands here, in
    // the log, which is the only place it goes. No signal either: the death's
    // own sandbox report wakes the box (see `reviveColdTurns`).
    log.info(
      {
        ...input.reporter,
        turnId: input.turnId,
        conversationId: input.conversationId,
        error: input.error,
        errorCode: input.errorCode,
      },
      "cold-dead turn revived in place; it will run again on a fresh boot",
    );
    return;
  }

  // The close won and the conversation is free: the oldest parked follow-up
  // runs NOW, not on the next poll pass (which can be a held-poll's whole
  // window away). After the transaction on purpose — promotion can lose the
  // partial index to a racing send (P2002), and that must cost the promotion
  // attempt, never the close that already committed.
  if (count > 0) {
    await promoteOldestParkedFollowUp(input.conversationId).catch(
      (err: unknown) =>
        log.warn(
          { err, conversationId: input.conversationId },
          "follow-up promotion after close failed; the poll pass will retry",
        ),
    );
  }

  if (count === 0) {
    // Either the turn does not exist, or it is not this runner's to finish,
    // or a sweep (ceiling / stall) or strand door already failed it and this
    // is the real work's late report. Deliberately one message for all of
    // them: a runner learns nothing about what else the control plane holds.
    log.warn(
      {
        ...input.reporter,
        turnId: input.turnId,
        conversationId: input.conversationId,
      },
      "finish for a turn this sandbox does not host",
    );

    // THE SALVAGE. When the lost race was against a sweep, the report in
    // hand is the only copy of two things the sweep could not know: what the
    // turn cost (`usage`) and where its session lives (`sessionRef` — the
    // resume handle without which the NEXT turn starts a stranger). Each is
    // one fenced statement: the write happens only if the named turn is this
    // reporter's (the full reporter fence — the cross-tenant tests pin it)
    // AND already terminal, so a bogus id or a foreign sandbox still writes
    // nothing, and the won-close path above remains the only writer for live
    // turns. Everything else about the report stays dropped on purpose — the
    // sweep already settled the automation, and a failed row's copy must not
    // be rewritten by the loser.
    if (input.usage) {
      await db.turn.updateMany({
        where: {
          id: input.turnId,
          conversationId: input.conversationId,
          status: { in: ["failed", "aborted"] },
          // Never overwrite: a won close that recorded usage keeps its word.
          usage: { equals: Prisma.DbNull },
          conversation: {
            agent: {
              sandbox: {
                id: input.reporter.sandboxId,
                runnerId: input.reporter.runnerId,
              },
            },
          },
        },
        data: { usage: input.usage },
      });
    }
    if (input.sessionRef) {
      // The extra `none: active` leg is the dying-boot guard: if a NEWER
      // turn is already underway, its own close will persist a fresher ref —
      // a stale boot's ref must not repoint a conversation that moved on.
      await db.conversation.updateMany({
        where: {
          id: input.conversationId,
          agent: {
            sandbox: {
              id: input.reporter.sandboxId,
              runnerId: input.reporter.runnerId,
            },
          },
          turns: {
            some: {
              id: input.turnId,
              status: { in: ["failed", "aborted"] },
            },
            none: {
              status: { in: ACTIVE_TURN_STATUSES as unknown as string[] },
            },
          },
        },
        data: { harnessSessionRef: input.sessionRef },
      });
    }
    return;
  }

  if (known) {
    // The row now carries the canonical copy; the raw detail is operator
    // material and lives here only.
    log.warn(
      {
        ...input.reporter,
        turnId: input.turnId,
        errorCode: input.errorCode,
        error: input.error,
      },
      "harness failure closed with canonical copy",
    );
  }

  // Step 7: a finished SCHEDULED run settles its cron (outcome bookkeeping,
  // auto-disable) and delivers its report. After the close-out transaction,
  // deliberately: the session-ref write above must never hinge on delivery,
  // and the fenced status transition already guarantees this runs at most
  // once per turn. The residue is honest at-most-once delivery — a crash in
  // this window loses the report but never the run (same posture as the
  // runner's fire-and-forget event reports).
  await settleAutomationRun(input).catch((err) =>
    log.error(
      { err, turnId: input.turnId, conversationId: input.conversationId },
      "automation settle failed after turn close",
    ),
  );

  // A busy-origin watch bucket waits out its fire lease; this conversation
  // just freed its slot, so put those watches back in the next poll's reach.
  // Best-effort — a miss retries at the lease anyway.
  await releaseWatchFireClaimsForConversation(input.conversationId).catch(
    (err) =>
      log.warn(
        { err, conversationId: input.conversationId },
        "watch fire-claim release failed after turn close",
      ),
  );
};

/** Delivery headers repeat the automation's operator/agent-named label —
 * clamped and stripped like every other name spliced into platform text. */
const cleanAutomationName = (raw: string): string =>
  stripControl(raw).replace(/\n/g, " ").trim().slice(0, 100);

/**
 * What the settle chain actually reads — the identity of the run and how it
 * ended, nothing reporter-shaped. Narrowed from `FinishTurnInput` so the
 * sweeps (which have no reporter — the control plane itself ended the turn)
 * can settle through the same chain as a real close.
 */
type AutomationSettleInput = Pick<
  FinishTurnInput,
  "conversationId" | "turnId" | "status" | "error" | "errorCode"
>;

/**
 * Settle automation bookkeeping for turns a SWEEP failed (ceiling / stall).
 * The sweeps' raw UPDATEs bypass `finishTurn`, and its late real report is a
 * fenced no-op — so without this, a ceiling-killed cron kept a stale
 * `lastOutcome` forever, never counted a failure strike, and never delivered
 * its report. Exactly-once holds structurally: the sweep's
 * `UPDATE … RETURNING` yields only rows it actually transitioned, and the
 * losing close can never settle (it returns before the settle call). Rows
 * settle independently — one broken conversation must not starve the rest.
 */
export const settleSweptTurns = async (swept: SweptTurn[]): Promise<void> => {
  for (const turn of swept) {
    await settleAutomationRun({
      conversationId: turn.conversationId,
      turnId: turn.turnId,
      status: "failed",
      error: turn.error,
      errorCode: turn.errorCode,
    }).catch((err) =>
      log.warn(
        { err, turnId: turn.turnId, conversationId: turn.conversationId },
        "automation settle failed after sweep",
      ),
    );
  }
};

/** The run's report body — its last text event, or a status-shaped fallback.
 * Shared by both automation kinds so their delivery reads identically. */
const runReport = async (input: AutomationSettleInput): Promise<string> => {
  // A coded failure reports its CANONICAL copy, same as the turn row — the
  // raw wire error must not reach the automation's delivery surface either.
  // Either detail also makes the transcript read below unnecessary.
  if (input.status !== "done") {
    const detail = knownFailureCopy(input)?.message ?? input.error;
    if (detail) return `The run failed: ${detail}`;
  }
  const textEvent = await db.turnEvent.findFirst({
    where: { turnId: input.turnId, type: "text" },
    orderBy: { seq: "desc" },
    select: { payload: true },
  });
  const answer = String(
    (textEvent?.payload as { text?: unknown } | null)?.text ?? "",
  ).trim();
  return input.status === "done"
    ? answer || "The run finished without producing a report."
    : `The run failed: ${answer || "no detail was reported."}`;
};

/** A finished non-human run settles its automation source. Dispatches on the
 * conversation's `source`: crons carry outcome bookkeeping + auto-disable;
 * watches are one-shot (status already `fired`), so they only deliver. */
const settleAutomationRun = async (
  input: AutomationSettleInput,
): Promise<void> => {
  const conversation = await db.conversation.findUnique({
    where: { id: input.conversationId },
    select: { source: true, externalRef: true },
  });
  if (!conversation?.externalRef) return;
  if (conversation.source === "watch") {
    await settleWatchRun(input, conversation.externalRef);
    return;
  }
  if (conversation.source !== "cron") return;

  const cron = await db.agentCron.findUnique({
    where: { id: conversation.externalRef },
    select: {
      id: true,
      name: true,
      originConversationId: true,
      consecutiveFailures: true,
    },
  });
  if (!cron) return; // schedule deleted while its last run was in flight

  if (input.status === "done") {
    await db.agentCron.update({
      where: { id: cron.id },
      data: { lastOutcome: "ok", consecutiveFailures: 0 },
    });
  } else if (input.status === "failed") {
    const failures = cron.consecutiveFailures + 1;
    // The auto-disable the plan requires: a schedule must not fire broken
    // forever. Five consecutive failures turn it off with a reason the
    // dashboard shows; one success resets the count (above).
    await db.agentCron.update({
      where: { id: cron.id },
      data: {
        lastOutcome: "failed",
        consecutiveFailures: failures,
        ...(failures >= CRON_FAILURE_DISABLE_THRESHOLD && {
          enabled: false,
          disabledReason: "failures",
        }),
      },
    });
  } else {
    // Aborted = a human stopped it. An outcome worth showing, but not a
    // symptom of a broken schedule — no failure count, no delivery.
    await db.agentCron.update({
      where: { id: cron.id },
      data: { lastOutcome: "failed" },
    });
    return;
  }

  if (!cron.originConversationId) return;

  await materializeAutomationDelivery(
    cron.originConversationId,
    `Scheduled run "${cleanAutomationName(cron.name)}"`,
    await runReport(input),
    "cron",
  );
};

/**
 * A watch's run finished. Watches are ONE-SHOT — the fire pass already moved
 * the row to `fired`, so there is no outcome bookkeeping and nothing to
 * disable; this only delivers the report to the origin. An aborted run (a
 * human stopped it) delivers nothing, matching the cron posture.
 */
const settleWatchRun = async (
  input: AutomationSettleInput,
  watchId: string,
): Promise<void> => {
  if (input.status === "aborted") return;
  const watch = await db.processWatch.findUnique({
    where: { id: watchId },
    select: {
      originConversationId: true,
      process: { select: { name: true, command: true } },
    },
  });
  if (!watch?.originConversationId) return;
  const label = cleanAutomationName(
    watch.process.name ?? watch.process.command,
  );
  await materializeAutomationDelivery(
    watch.originConversationId,
    `Watch on "${label}"`,
    await runReport(input),
    "watch",
  );
};

/**
 * The report lands in the ORIGIN conversation as a completed turn — decided
 * with the user (2026-08-07): output goes where the schedule was born. This
 * shape is the whole delivery mechanism: the web thread renders it from the
 * transcript it already streams, and the channel completion pass mirrors it
 * to Slack because it is a finished turn in a linked conversation — zero new
 * adapter plumbing. It never passes through the origin's harness session
 * (that is what the continuity bridge above is for).
 *
 * Same seq discipline as `applyTurnEvents`: the conversation-row lock makes
 * seq order commit order, and the publish happens after commit.
 */
export const materializeAutomationDelivery = async (
  originConversationId: string,
  header: string,
  report: string,
  /** The delivery turn's source — the mirror keys its per-run shape on it. */
  source: "cron" | "watch",
): Promise<void> => {
  const now = new Date();
  const published = await db.$transaction(async (tx) => {
    const origin = await tx.conversation.findUnique({
      where: { id: originConversationId },
      select: { id: true },
    });
    if (!origin) return null; // origin deleted — the schedule outlives it

    const { lastSeq } = await tx.conversation.update({
      where: { id: originConversationId },
      data: { lastSeq: { increment: 2 } },
      select: { lastSeq: true },
    });
    const textSeq = lastSeq - 1;

    const turn = await tx.turn.create({
      data: {
        conversationId: originConversationId,
        message: header,
        // Born terminal: a delivery is a record of something that already
        // happened, never dispatchable work — so it can never trip the
        // one-active-turn index or reach a sandbox.
        status: "done",
        source,
        userId: null,
        startedAt: now,
        finishedAt: now,
      },
      select: { id: true },
    });

    // TWO events, text then turn.done — the terminal is what tells every
    // live consumer "a turn row exists and is finished". Without it the
    // open web thread never learns the delivery landed (its new-turn signal
    // is the boundary set turn.started|turn.done|error), and the delivery's
    // transcript records a turn that never ends. Same seq discipline: both
    // rows under the one row-lock increment, published together.
    const textEvent = { type: "text" as const, text: report };
    const doneEvent = { type: "turn.done" as const };
    await tx.turnEvent.createMany({
      data: [
        {
          conversationId: originConversationId,
          turnId: turn.id,
          seq: textSeq,
          type: "text",
          payload: textEvent as unknown as Prisma.InputJsonValue,
        },
        {
          conversationId: originConversationId,
          turnId: turn.id,
          seq: lastSeq,
          type: "turn.done",
          payload: doneEvent as unknown as Prisma.InputJsonValue,
        },
      ],
    });

    return [
      { seq: textSeq, turnId: turn.id, type: "text", event: textEvent },
      { seq: lastSeq, turnId: turn.id, type: "turn.done", event: doneEvent },
    ] satisfies PublishedEvent[];
  });

  if (published) getEventBus().publish(originConversationId, published);
};

/**
 * The transcript, oldest first, from a cursor. This is the source of truth
 * every live stream reconciles against: a reader fetches history, then tails
 * from the highest `seq` it saw.
 */
export const readTranscript = async (
  workspaceId: string,
  conversationId: string,
  viewerUserId: string,
  params: { since?: number; limit?: number } = {},
) => {
  await requireConversation(workspaceId, conversationId, viewerUserId);
  return readTranscriptEvents(conversationId, params);
};

/**
 * The transcript page WITHOUT a caller fence — the shared core under
 * `readTranscript` (workspace + direct-owner fenced) and the channel adapter's
 * read (fenced by thread-link ownership in `channel-adapter-service`). Never
 * expose this from a route directly: every caller must have already answered
 * "may this identity read this conversation" its own way.
 */
export const readTranscriptEvents = async (
  conversationId: string,
  params: { since?: number; limit?: number } = {},
) => {
  const limit = Math.min(params.limit ?? 200, 500);

  const events = await db.turnEvent.findMany({
    where: {
      conversationId,
      ...(params.since !== undefined && { seq: { gt: params.since } }),
    },
    select: { seq: true, turnId: true, type: true, payload: true },
    orderBy: { seq: "asc" },
    take: limit + 1,
  });

  const hasMore = events.length > limit;
  const page = hasMore ? events.slice(0, limit) : events;
  return {
    events: page,
    nextSince: page.at(-1)?.seq ?? params.since ?? 0,
    hasMore,
  };
};
