import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../../providers";
import { channelProvider, isChannelProviderId } from "./registry";
import { chooseReaction } from "../judges/reaction-judge";
import { ChannelProviderApiError } from "./errors";
import type {
  ChannelProvider,
  ChannelProviderId,
  WaitingMessage,
} from "./types";
import { noteOutboundFailure } from "./agent-channel-service";
import {
  AUTOMATION_SOURCES,
  MAX_JOINING_FOLLOW_UPS,
} from "../../validations/conversation";
import { logger } from "../../lib/logger";

const log = logger.child({ component: "turn-receipts" });

/**
 * The turn-ack ledger (the "seen" mark): written by a detached task after an
 * ingest door accepts a turn, cleared by the cursor-advance that gates the
 * answer post. Two mark kinds share the one ledger:
 *
 * - "reaction": an AI-chosen emoji on the triggering message — every DM,
 *   every regular-flavor app, and the fallback below.
 * - "session": the provider's NATIVE thread work-status (Slack: the agent
 *   session "Working…" loader) — agent-flavor presences in group threads.
 *   Falls back to the reaction on ANY refusal (plan-gated workspace, missing
 *   scope, dead credential): the ack must never silently vanish.
 *
 * Everything here is best-effort and detached — a mark is cosmetic, so no
 * failure may surface to an ingest ack or the adapter's cursor call.
 * Restart-safe by construction: the row IS the state, and rows older than
 * the prune window are deleted opportunistically (turns whose cursor never
 * advances — an agent deleted mid-turn — age out).
 */

const RECEIPT_PRUNE_MS = 24 * 60 * 60 * 1000;

export interface AttachReceiptInput {
  presenceId: string;
  turnId: string;
  /** Provider-opaque address of the USER's message (Slack: channel + ts). */
  channel: string;
  messageTs: string;
  /** The SESSION root (Slack: `thread_ts`) — the key the native work-status
   * is set on. A group mention uses the thread it answers in; a DM has no
   * thread, so the caller passes the user's own message, because Slack
   * refuses to scope a session without one. */
  threadTs?: string | null;
  /** Where a narration CARD may be posted: the thread's root — a group
   * thread, or the DM thread the person typed in — or null at the top level
   * of a DM, so the card sits inline. Deliberately separate from `threadTs`
   * above — an unthreaded DM fakes a session root out of the user's message,
   * and reusing it here would open a thread for every DM turn. */
  replyThreadTs?: string | null;
  /** Whether the conversation has NO thread to hang a loader on (the top
   * level of a DM). Explicit rather than inferred from a null thread: the
   * native work-status opens a thread there (Slack documents it), so a
   * card-capable provider skips the enum — and a caller that omits the field
   * must keep today's behavior, not silently disable every channel's loader.
   *
   * Keyed on the ADDRESS, not the door: a DM reply typed inside a thread is
   * still a direct conversation, but it already has a thread, so it gets the
   * loader like any other threaded surface. */
  unthreaded?: boolean;
  /** The inbound message text — what the chooser picks against. */
  text: string;
}

/**
 * Persist the mark and set it on the provider. Called `void` from the
 * dispatch layer AFTER the door answered — by then the turn exists and the
 * ack no longer depends on anything here.
 *
 * THE RACE THIS MUST SURVIVE (live incident, 2026-08-30): this detached task
 * spends real time before its row exists — a KMS decrypt plus a provider
 * round-trip (Slack setStatus: 15s timeout, retries) — while a fast turn can
 * answer and fire `clearTurnReceipts` ~2.5s after the message. The early
 * clear finds no row, no-ops, and the mark lands AFTER it with nothing left
 * to clear (a session loader then burns until the provider's 1h timeout).
 * The cure is `selfClearIfTurnFinished` below: after the mark is set, re-read
 * the turn and self-clear when it already finished.
 */
export const attachTurnReceipt = async (
  input: AttachReceiptInput,
): Promise<void> => {
  try {
    const presence = await db.agentChannel.findUnique({
      where: { id: input.presenceId },
      select: {
        id: true,
        provider: true,
        appMode: true,
        credentials: true,
        agent: {
          select: {
            id: true,
            workspaceId: true,
            workspace: { select: { organizationId: true } },
          },
        },
      },
    });
    if (!presence) return;

    const credentialsJson = presence.credentials
      ? await getCrypto().decrypt(presence.credentials)
      : null;
    const provider = channelProvider(presence.provider as ChannelProviderId);

    // The native work-status ("<agent> is working…") is the ack for an
    // agent-flavor presence. Try it first — on any refusal (plan-gated
    // workspace, missing scope, dead credential) fall through to the
    // reaction, so the user always sees SOMETHING move.
    //
    // NOT AT THE TOP LEVEL OF A DM, when the presence can post a narration
    // card instead. Slack documents that setting an agent-session status
    // there "will automatically open the thread for the user", and it says
    // only that the agent is busy. The card says WHAT it is doing and sits
    // inline, so the enum would cost a thread nobody asked for and buy
    // nothing the card does not already show. Anything ALREADY threaded
    // keeps it — a channel thread, and equally a DM thread the person opened
    // themselves: the thread exists either way, and the loader is what
    // surfaces the agent as working in it.
    // Keyed on an explicit flag rather than "replyThreadTs is absent" — a
    // caller that simply does not pass the field would otherwise read as
    // unthreaded and silently cost every channel its loader.
    const narratesInline =
      input.unthreaded === true && provider.narrateThreadWork !== undefined;
    if (
      presence.appMode === "agent" &&
      input.threadTs &&
      provider.setThreadWorkStatus
    ) {
      const threadTs = input.threadTs;
      let statusSet = false;
      try {
        // The session receipt is written either way — it is what the
        // narration card hangs off. Only the ENUM is conditional.
        if (!narratesInline) {
          await provider.setThreadWorkStatus({
            credentialsJson,
            channel: input.channel,
            threadTs,
            working: true,
          });
          statusSet = true;
        }
        // The SEEN mark, on the user's own message. In a card-only DM this
        // is the only acknowledgement that lands on what they typed — the
        // card is a separate message, and a reader who sends and looks away
        // wants a mark on their own line. It rides ALONGSIDE the card here
        // rather than instead of it (elsewhere it is the fallback), so both
        // signals are present: "seen" on the message, "doing" on the card.
        let seenReaction: string | null = null;
        if (narratesInline) {
          seenReaction = await chooseReaction({
            agent: {
              id: presence.agent.id,
              workspaceId: presence.agent.workspaceId,
            },
            organizationId: presence.agent.workspace.organizationId,
            text: input.text,
          });
          try {
            await provider.addReceiptReaction({
              credentialsJson,
              channel: input.channel,
              messageTs: input.messageTs,
              reaction: seenReaction,
            });
          } catch (err) {
            // Decoration on top of the card: a refused emoji costs the mark,
            // never the turn. A dead credential still flips the presence.
            void noteOutboundFailure(input.presenceId, err);
            log.info(
              { err: String(err), turnId: input.turnId },
              "seen mark skipped; the card stands",
            );
            seenReaction = null;
          }
        }

        try {
          await db.channelTurnReceipt.create({
            data: {
              turnId: input.turnId,
              agentChannelId: presence.id,
              channel: input.channel,
              // The THREAD ROOT, not the message: it is the address the
              // clear must set the status back on.
              messageTs: threadTs,
              // The card's home: the group thread when there is one, null in
              // a DM so the card sits inline. NOT `threadTs` above — that is
              // the session root, which a DM fakes from the user's message.
              cardThreadTs: input.replyThreadTs ?? null,
              // Recorded, not inferred: the clear cannot otherwise tell a
              // card-only DM from a channel whose loader is standing.
              workStatusSet: !narratesInline,
              kind: "session",
              // Set only on a card-only DM, where the mark rides beside the
              // card. The clear takes it off the USER's message, which is
              // why `seenMessageTs` is stored next to it — `messageTs` on a
              // session row is the thread root, not the user's line.
              reaction: seenReaction,
              seenMessageTs: seenReaction === null ? null : input.messageTs,
            },
            select: { id: true },
          });
        } catch (err) {
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === "P2002"
          ) {
            return; // a twin already receipted this turn — its mark stands
          }
          throw err;
        }
        pruneOldReceipts(presence.id);
        await selfClearIfTurnFinished(input.turnId);
        return;
      } catch (err) {
        // A loader with no ledger row would burn until Slack's 1h timeout —
        // if it made it on before the failure, best-effort take it off
        // before falling back to the reaction.
        if (statusSet) {
          void provider
            .setThreadWorkStatus({
              credentialsJson,
              channel: input.channel,
              threadTs,
              working: false,
            })
            .catch(() => {});
        }
        log.info(
          { err: String(err), turnId: input.turnId },
          "work-status refused; falling back to reaction",
        );
      }
    }

    const reaction = await chooseReaction({
      agent: { id: presence.agent.id, workspaceId: presence.agent.workspaceId },
      organizationId: presence.agent.workspace.organizationId,
      text: input.text,
    });

    try {
      await db.channelTurnReceipt.create({
        data: {
          turnId: input.turnId,
          agentChannelId: presence.id,
          channel: input.channel,
          messageTs: input.messageTs,
          kind: "reaction",
          reaction,
        },
        select: { id: true },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        return; // a twin already receipted this turn — its reaction stands
      }
      throw err;
    }

    pruneOldReceipts(presence.id);

    await provider.addReceiptReaction({
      credentialsJson,
      channel: input.channel,
      messageTs: input.messageTs,
      reaction,
    });
    await selfClearIfTurnFinished(input.turnId);
  } catch (err) {
    // The receipt is the FIRST outbound call an inbound message triggers, so
    // it is where a removed app (deleted at api.slack.com, a missed webhook)
    // is most likely to surface: a dead-credential refusal flips the presence
    // here. Everything else is still best-effort decoration.
    void noteOutboundFailure(input.presenceId, err);
    log.warn({ err: String(err), turnId: input.turnId }, "receipt add skipped");
  }
};

/**
 * The attach-vs-clear race's closing move: the cursor-advance clear fires
 * only AFTER a turn reached a terminal status (the CAS that gates the
 * answer post), so terminal status observed HERE proves any clear for this
 * turn has either run already — possibly before our row existed, no-oping —
 * or needs no mark to exist. Either way the mark we just set is stale on
 * arrival: take it off ourselves. Terminal is monotonic, so there is no
 * interleaving where both this recheck and the real clear miss.
 *
 * A `joined` follow-up is NOT terminal evidence by itself — it joins a
 * parent that may still be running (its mark must stay). Its clear fires
 * through the PARENT's `clearTurnReceipts`, so the parent's status is the
 * truth to check for it.
 */
const selfClearIfTurnFinished = async (turnId: string): Promise<void> => {
  const turn = await db.turn.findUnique({
    where: { id: turnId },
    select: { status: true, followUpOfTurnId: true },
  });
  if (!turn) return;
  let finished = TERMINAL_TURN_STATUSES.has(turn.status);
  if (!finished && turn.status === "joined" && turn.followUpOfTurnId) {
    const parent = await db.turn.findUnique({
      where: { id: turn.followUpOfTurnId },
      select: { status: true },
    });
    finished = parent !== null && TERMINAL_TURN_STATUSES.has(parent.status);
  }
  if (!finished) return;
  log.info({ turnId }, "turn finished before its mark landed; self-clearing");
  await clearTurnReceipt(turnId);
};

/** The statuses that gate the answer post — a turn past answering. `joined`
 * is deliberately absent (see above); `joining`/`queued`/`dispatched`/
 * `running` are live. */
const TERMINAL_TURN_STATUSES = new Set(["done", "failed", "aborted"]);

/** A session loader older than this with no LIVE turn behind it is presumed
 * leaked (a real turn's clear lands in seconds of its close). Well under
 * Slack's 1h session timeout — the sweep's whole point is beating it. */
const STALE_SESSION_MS = 10 * 60 * 1000;

/** Bounded per pass: the sweep rides a hot poll path; a pathological backlog
 * drains over successive passes instead of stalling one. */
const STALE_SESSION_SWEEP_LIMIT = 20;

/**
 * The turn statuses that hold a conversation's active slot — a loader on one
 * of these is a LIVE loader, never a leak. Mirrors the turn model's own
 * definition (`joining` is parked behind a live turn and counts as live for
 * this purpose: its loader will move or clear with the exchange). A
 * function, not a module-level const, so unit lanes with a mocked
 * `@onecli/db` (whose `Prisma` carries no `sql`) can import this module
 * without ever touching the real tagged-template helper.
 */
const liveTurnStatuses = () =>
  Prisma.join(["queued", "dispatched", "running", "joining"]);

/**
 * The guarantee behind the recheck: any session loader that slipped every
 * fast-path clear (a crash between the provider call and the row insert, a
 * refused clear, a future regression of the terminal-before-clear invariant)
 * is set back to rest within minutes, not Slack's hour. Deliberately
 * session-only — stale REACTION rows are cosmetic and the 24h prune owns
 * them. Best-effort per row: a failed provider call keeps the row for the
 * next pass; the delete happens only after the provider acknowledged.
 *
 * STATUS-AWARE, not age-only (live 2026-09-15): a loader whose turn is still
 * live is not leaked, whatever its age — a long turn is legitimate, and
 * yanking its card and seen mark at ten minutes made the agent look
 * abandoned mid-run (the user pinged "?" seconds before the answer landed).
 * A turn is live while it holds the conversation's active slot, or is a
 * `joined` follow-up whose parent still does; every other shape — no turn
 * row at all (a deleted agent's cascade), a terminal turn, a `joined` row
 * under a terminal or missing parent — is exactly the leak this exists for.
 *
 * Liveness is STATUS only, by design. The stall clock (`last_progress_at`)
 * is `failStalledTurns`' business: a wedged turn is failed there, that
 * terminal status flows through the ordinary cursor-advance clear, and a
 * second copy of the stall rule here would only drift from the first.
 *
 * The exclusion lives IN the query rather than after it: with a post-filter,
 * twenty old receipts on live long turns would fill the batch on every pass
 * and a real leak behind them would never be reached.
 */
export const sweepStaleSessionReceipts = async (): Promise<void> => {
  try {
    const before = new Date(Date.now() - STALE_SESSION_MS);
    const live = liveTurnStatuses();
    const stale = await db.$queryRaw<{ turn_id: string }[]>`
      SELECT r.turn_id
      FROM channel_turn_receipts r
      WHERE r.kind = 'session'
        AND r.created_at < ${before}
        AND NOT EXISTS (
          SELECT 1 FROM turns t
          WHERE t.id = r.turn_id
            AND (
              t.status IN (${live})
              OR (
                t.status = 'joined'
                AND EXISTS (
                  SELECT 1 FROM turns p
                  WHERE p.id = t.follow_up_of_turn_id
                    AND p.status IN (${live})
                )
              )
            )
        )
      ORDER BY r.created_at ASC
      LIMIT ${STALE_SESSION_SWEEP_LIMIT}
    `;
    for (const row of stale) {
      log.warn({ turnId: row.turn_id }, "stale session loader; sweeping clear");
      await clearTurnReceipt(row.turn_id);
    }
  } catch (err) {
    log.warn({ err: String(err) }, "stale-session sweep skipped");
  }
};

/** Fire-and-forget prune: losing one pass costs nothing. */
const pruneOldReceipts = (agentChannelId: string): void => {
  db.channelTurnReceipt
    .deleteMany({
      where: {
        agentChannelId,
        createdAt: { lt: new Date(Date.now() - RECEIPT_PRUNE_MS) },
      },
    })
    .catch(() => {});
};

/**
 * Floor between two narration writes on one turn.
 *
 * Slack's message write is rate-limited per app and a busy agent can run
 * tools faster than the ceiling allows, so tool boundaries alone are not a
 * bound. 1.5s keeps a long turn's narration comfortably inside it while
 * still reading as live.
 */
const NARRATION_MIN_INTERVAL_MS = 1_500;

/**
 * How many steps a card shows before the oldest fall off.
 *
 * A card is a loader, not a transcript: past a screenful it stops being
 * glanceable, and Slack caps a plan at 50 tasks regardless. The full history
 * lives in the web transcript, which is the surface built to hold it.
 */
const NARRATION_MAX_STEPS = 12;

/**
 * REMOVE a turn's narration card, if it has one.
 *
 * Shared by the clear path and the stale sweep because both must be safe to
 * run alone and safe to run twice: whichever gets there first removes the
 * card, and the other finds nothing (or a provider that answers "already
 * gone", which the provider swallows).
 */
const removeNarrationCard = async (
  provider: ChannelProvider,
  input: { credentialsJson: string | null; channel: string; cardTs: string },
): Promise<void> => {
  if (!provider.removeThreadNarration) return;
  await provider.removeThreadNarration(input);
};

/**
 * The messages a turn's card lists as waiting: sent to this run while it
 * works, not read yet, oldest first. A person's words only: a joined
 * automation (a cron or watch wake, a peer task's report) is the platform
 * talking, and its card row would quote an instruction nobody typed. Each
 * row names its author on THIS integration when they are linked, which is
 * what puts their Send now on it.
 *
 * One indexed read (`followUpOfTurnId`), bounded by the per-conversation
 * follow-up cap, so a card render costs the same however busy the thread.
 */
const waitingMessagesFor = async (
  turnId: string,
  integrationId: string,
): Promise<WaitingMessage[]> => {
  const rows = await db.turn.findMany({
    where: {
      followUpOfTurnId: turnId,
      status: "joining",
      source: { notIn: [...AUTOMATION_SOURCES] },
    },
    orderBy: { createdAt: "asc" },
    take: MAX_JOINING_FOLLOW_UPS,
    select: {
      id: true,
      message: true,
      user: {
        select: {
          channelUserLinks: {
            where: { integrationId },
            select: { externalUserId: true },
          },
        },
      },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    text: row.message,
    authorExternalUserId: row.user?.channelUserLinks[0]?.externalUserId ?? null,
  }));
};

/**
 * NARRATE the turn's current activity on its own card beside the
 * conversation: one row per tool call, the newest running, then a row for
 * each message still waiting to be read (`waitingMessagesFor`).
 *
 * Best-effort and never load-bearing: the native loader is already standing
 * from the attach, so a provider that cannot narrate, a workspace that
 * refuses, and a turn whose receipt has already been cleared all end the
 * same way — nothing happens, and the turn is unaffected.
 *
 * Only a `session` receipt narrates: a `reaction` receipt is the fallback
 * for a presence whose provider has no native loader at all, and giving it a
 * card would be a second, louder mark than the one the user opted into.
 *
 * Costs one indexed lookup per tool batch on a turn with no channel receipt
 * (a web-only agent). No lock, no write, and that is why this stays a plain
 * lookup rather than a cache that would need invalidating.
 */
export const narrateTurnActivity = async (
  turnId: string,
  activity: string,
): Promise<void> => {
  try {
    const receipt = await findCardReceipt(turnId);
    // No session receipt = nothing to narrate onto (a reaction fallback, or
    // a turn whose loader already came down). Not a problem.
    if (!receipt) return;
    // The same step repeated: the card already says this, and rewriting it
    // with itself would spend Slack's rate limit on nothing.
    if (receipt.cardSteps.at(-1) === activity) return;

    const provider = narratorFor(receipt);
    if (!provider) return;

    const steps = [...receipt.cardSteps, activity].slice(-NARRATION_MAX_STEPS);

    // RECORD the step before talking to the provider. The route pushes
    // narration detached, so two batches for one turn can be in flight
    // together; writing the list here (not after the call) means the second
    // caller reads the first's step and APPENDS to it rather than racing
    // it: the card grows, it never rewinds.
    //
    // The revision is bumped for the posting rule below. A turn with no card
    // yet also opens the write window here: the first post IS the window's
    // write, so a refresh arriving meanwhile waits for it.
    await db.channelTurnReceipt.updateMany({
      where: { id: receipt.id },
      data: {
        cardSteps: steps,
        cardRev: { increment: 1 },
        ...(receipt.cardTs === null && { cardAt: new Date() }),
      },
    });

    // A card already up is written through the paced path, which shows this
    // step now or at the end of the current write window. Never dropped: an
    // agent that runs a fast tool and then a long one must not leave the card
    // naming the fast one for the whole of the long one.
    if (receipt.cardTs !== null) {
      await refreshTurnCard(turnId);
      return;
    }

    // POSTING is exclusive, and recording the step does not make it so:
    // `cardTs` is written only once the provider answers, so a caller
    // arriving during that round-trip still reads null and would post a
    // SECOND card. The first writer (the one that found revision 0) posts;
    // everyone else hands its step to the paced path, which renders it once
    // the post has landed.
    if (receipt.cardRev > 0) {
      await refreshTurnCard(turnId);
      return;
    }

    const result = await renderCard(provider, receipt, steps);
    // Null = this provider or workspace cannot narrate. RELEASE the claim so
    // the row still reflects what is actually on screen, and nothing later
    // tries to remove a card that was never posted.
    if (!result) {
      await db.channelTurnReceipt.updateMany({
        // Only if nothing else has written since: a later step's list is
        // fresher than the one we are rolling back to.
        where: { id: receipt.id, cardRev: receipt.cardRev + 1 },
        data: { cardSteps: receipt.cardSteps },
      });
      return;
    }

    // Record the card handle. `updateMany` scoped to the row id makes a
    // clear that landed in between a no-op rather than resurrecting a
    // deleted receipt.
    await db.channelTurnReceipt.updateMany({
      where: { id: receipt.id },
      data: { cardTs: result.cardTs },
    });
    // Whatever changed while the post was in flight (a step, a message
    // accepted or read) moved the revision past this post's own and is owed
    // to the card: the paced path shows it now that there is a card to
    // write. Read AFTER the handle is recorded, so a change either moved the
    // revision before this read or found the card and took the paced path
    // itself.
    const landed = await db.channelTurnReceipt.findUnique({
      where: { id: receipt.id },
      select: { cardRev: true },
    });
    if (landed && landed.cardRev !== receipt.cardRev + 1) {
      await refreshTurnCard(turnId);
    }
  } catch (err) {
    logCardFailure(
      err,
      turnId,
      "activity narration skipped; the loader stands",
    );
  }
};

/**
 * WRITE a turn's posted card as it stands now (its steps, and the messages
 * waiting on it), at most once per write window. Called whenever either
 * changes: a step (above), a message accepted under the card, or the agent
 * reading one, so a row appears with its Send now and leaves the moment its
 * message is read.
 *
 * Paced, never dropped. Slack's message write is rate-limited per app, so
 * one write per window (`NARRATION_MIN_INTERVAL_MS`) is the rule for every
 * write to the card. A change that finds the window taken is deferred to
 * the window's end, every change deferred in that window collapses into
 * that one write, and the write reads the state as it is then. In-process
 * and best-effort: a restart inside a window costs one write, which the next
 * change repairs.
 *
 * Only a posted card is written here. Before the first step there is no
 * card, and the first post lists whatever is waiting by then. While the
 * first post is in flight, a change marks itself owed (it moves the
 * revision) and the poster shows it once the card lands.
 */
export const refreshTurnCard = async (turnId: string): Promise<void> => {
  try {
    // CLAIM the window in one statement, so two writers (a step and a
    // refresh, or two processes) can never both take it: the first moves the
    // clock, and the second's condition no longer holds.
    const claimed = await db.channelTurnReceipt.updateMany({
      where: {
        turnId,
        kind: "session",
        cardTs: { not: null },
        OR: [
          { cardAt: null },
          { cardAt: { lte: new Date(Date.now() - NARRATION_MIN_INTERVAL_MS) } },
        ],
      },
      data: { cardAt: new Date() },
    });
    if (claimed.count === 0) {
      // No card yet, but a first post has begun (the revision moved): mark
      // this change owed for the poster, which can wait longer than any
      // window. A refused post leaves the same mark, which costs nothing:
      // that turn has no card to write. Nothing begun at all: the first
      // post lists what is waiting then.
      const owed = await db.channelTurnReceipt.updateMany({
        where: { turnId, kind: "session", cardTs: null, cardRev: { gt: 0 } },
        data: { cardRev: { increment: 1 } },
      });
      if (owed.count > 0) return;
      // A posted card whose window is taken: write once the window ends.
      const row = await db.channelTurnReceipt.findFirst({
        where: { turnId, kind: "session" },
        select: { cardTs: true, cardAt: true },
      });
      if (row?.cardTs) {
        deferCardRefresh(turnId, narrationFloorRemaining(row.cardAt));
      }
      return;
    }
    // Read the card AFTER the claim, so what is written is the newest state
    // rather than the one this call started from.
    const receipt = await findCardReceipt(turnId);
    if (!receipt) return;
    const provider = narratorFor(receipt);
    if (!provider) return;
    await renderCard(provider, receipt, receipt.cardSteps);
  } catch (err) {
    logCardFailure(err, turnId, "card write skipped; the loader stands");
  }
};

/** Deferred card refreshes in this process, one per turn: a change that
 * finds one already scheduled is covered by it. */
const deferredCardRefreshes = new Map<string, NodeJS.Timeout>();

const deferCardRefresh = (turnId: string, delayMs: number): void => {
  if (deferredCardRefreshes.has(turnId)) return;
  const timer = setTimeout(() => {
    deferredCardRefreshes.delete(turnId);
    void refreshTurnCard(turnId);
  }, delayMs);
  // A pending refresh is decoration: it must never hold a process open.
  timer.unref();
  deferredCardRefreshes.set(turnId, timer);
};

/** Test seam: cancel every deferred refresh and say which turns had one, so
 * a suite can assert a deferral and run it on its own clock. Never called by
 * production code. */
export const takeDeferredCardRefreshesForTests = (): string[] => {
  const turnIds = [...deferredCardRefreshes.keys()];
  for (const timer of deferredCardRefreshes.values()) clearTimeout(timer);
  deferredCardRefreshes.clear();
  return turnIds;
};

/** How long until the card may be written again (0 = now). */
const narrationFloorRemaining = (cardAt: Date | null): number =>
  cardAt
    ? Math.max(0, NARRATION_MIN_INTERVAL_MS - (Date.now() - cardAt.getTime()))
    : 0;

/** What a card render reads off the session receipt. */
const cardReceiptSelect = {
  id: true,
  turnId: true,
  channel: true,
  cardThreadTs: true,
  cardTs: true,
  cardSteps: true,
  cardRev: true,
  cardAt: true,
  workStatusSet: true,
  agentChannel: {
    select: { provider: true, credentials: true, integrationId: true },
  },
} satisfies Prisma.ChannelTurnReceiptSelect;

type CardReceipt = Prisma.ChannelTurnReceiptGetPayload<{
  select: typeof cardReceiptSelect;
}>;

const findCardReceipt = (turnId: string): Promise<CardReceipt | null> =>
  db.channelTurnReceipt.findFirst({
    where: { turnId, kind: "session" },
    select: cardReceiptSelect,
  });

type Narrator = ChannelProvider &
  Required<Pick<ChannelProvider, "narrateThreadWork">>;

const canNarrate = (provider: ChannelProvider): provider is Narrator =>
  provider.narrateThreadWork !== undefined;

/** The receipt's provider when it can narrate, else null: an unknown
 * provider string (a DB row must never crash a card write) and a provider
 * without a card both mean there is nothing to write. */
const narratorFor = (receipt: CardReceipt): Narrator | null => {
  const id = receipt.agentChannel.provider;
  if (!isChannelProviderId(id)) return null;
  const provider = channelProvider(id);
  return canNarrate(provider) ? provider : null;
};

/**
 * Write the card: the given steps, every message waiting on the turn now,
 * and Stop where no native loader stands. The ONE render both the step and
 * the refresh go through, so the card always shows the two together.
 */
const renderCard = async (
  provider: Narrator,
  receipt: CardReceipt,
  steps: string[],
): Promise<{ cardTs: string } | null> => {
  const [credentialsJson, waiting] = await Promise.all([
    receipt.agentChannel.credentials
      ? getCrypto().decrypt(receipt.agentChannel.credentials)
      : null,
    waitingMessagesFor(receipt.turnId, receipt.agentChannel.integrationId),
  ]);
  return provider.narrateThreadWork({
    credentialsJson,
    channel: receipt.channel,
    // A group thread's card belongs in that thread; a DM has none, and
    // passing null is what keeps the card inline instead of opening a
    // thread nobody asked for.
    threadTs: receipt.cardThreadTs,
    activities: steps,
    cardTs: receipt.cardTs,
    // The card is the only signal where no native loader stands, so it
    // carries the only Stop there is.
    stoppable: !receipt.workStatusSet,
    waiting,
  });
};

/**
 * A PROVIDER refusal is routine (plan-gated workspace, dead credential) and
 * stays at info: the loader is untouched and there is nothing to fix. A
 * fault on OUR side is not routine: it means narration is broken for
 * everyone, and swallowing it at the same level is how a missing column
 * looked exactly like a Slack refusal for a whole afternoon. Same swallow,
 * louder record.
 */
const logCardFailure = (err: unknown, turnId: string, line: string): void => {
  if (err instanceof ChannelProviderApiError) {
    log.info({ err: String(err), turnId }, line);
  } else {
    log.error({ err: String(err), turnId }, line);
  }
};

/**
 * The clear half, fired on a WINNING cursor CAS: the answer is posting, so
 * the "seen" mark comes off and the row goes with it. A missing row is the
 * normal case for web-sourced turns (they never had a receipt).
 */
export const clearTurnReceipt = async (turnId: string): Promise<void> => {
  try {
    const receipt = await db.channelTurnReceipt.findUnique({
      where: { turnId },
      select: {
        id: true,
        channel: true,
        messageTs: true,
        kind: true,
        reaction: true,
        workStatusSet: true,
        seenMessageTs: true,
        cardTs: true,
        agentChannel: { select: { provider: true, credentials: true } },
      },
    });
    if (!receipt) return;

    const credentialsJson = receipt.agentChannel.credentials
      ? await getCrypto().decrypt(receipt.agentChannel.credentials)
      : null;
    const provider = channelProvider(
      receipt.agentChannel.provider as ChannelProviderId,
    );

    // Take the CARD down first, while the loader is still up. The card is a
    // loader, not a reply: the answer is landing, so leaving it would end
    // every turn with two messages instead of one.
    if (receipt.cardTs) {
      await removeNarrationCard(provider, {
        credentialsJson,
        channel: receipt.channel,
        cardTs: receipt.cardTs,
      });
    }

    if (receipt.kind === "session" && receipt.workStatusSet) {
      // The native work-status is NOT auto-cleared by the answer post
      // (Slack: `agents.sessions.setStatus` semantics) — this call is the
      // only thing standing between the user and a loader that burns until
      // the provider's timeout. A refusal falls through to the catch: the
      // row survives, so a later clear can retry.
      await provider.setThreadWorkStatus?.({
        credentialsJson,
        channel: receipt.channel,
        threadTs: receipt.messageTs,
        working: false,
      });
    } else if (receipt.reaction && !receipt.seenMessageTs) {
      await provider.removeReceiptReaction({
        credentialsJson,
        channel: receipt.channel,
        messageTs: receipt.messageTs,
        reaction: receipt.reaction,
      });
    }

    // A seen mark riding BESIDE a card comes off with it. Its address is the
    // user's own message, which on a session row is not `messageTs` — that
    // is the thread root, so unreacting there would miss.
    if (receipt.reaction && receipt.seenMessageTs) {
      await provider.removeReceiptReaction({
        credentialsJson,
        channel: receipt.channel,
        messageTs: receipt.seenMessageTs,
        reaction: receipt.reaction,
      });
    }

    await db.channelTurnReceipt.delete({ where: { id: receipt.id } });
  } catch (err) {
    log.warn({ err: String(err), turnId }, "receipt clear skipped");
  }
};

/**
 * Clear the receipts of a finished turn AND its joined follow-ups — the
 * answer that is posting covers all of them, so every seen-mark the exchange
 * accumulated comes off. One indexed lookup resolves the family; the misses
 * (web-sourced turns, already-moved receipts) cost nothing.
 */
export const clearTurnReceipts = async (turnId: string): Promise<void> => {
  try {
    const joined = await db.turn.findMany({
      where: { followUpOfTurnId: turnId, status: "joined" },
      select: { id: true },
    });
    for (const id of [turnId, ...joined.map((row) => row.id)]) {
      await clearTurnReceipt(id);
    }
  } catch (err) {
    log.warn({ err: String(err), turnId }, "receipt family clear skipped");
  }
};

/**
 * The turn behind a live loader, by the address a Stop names it by. Two
 * kinds of loader, two addresses, one row:
 *
 *   - the provider's NATIVE loader (Slack: `agent_session_stopped`) names
 *     the conversation and the THREAD ROOT, which is `messageTs` on a
 *     session receipt;
 *   - the narration CARD's own Stop (where no native loader stands, so the
 *     card carries the only one) names the conversation and the CARD
 *     message, which is `cardTs`.
 *
 * The session receipt IS the mapping: written exactly when the loader goes
 * on, removed when the answer clears it. A row here means "this turn put
 * that loader up"; no row means nothing of ours is working there. Scoped to
 * the presence, so an address on another app's loader never matches.
 *
 * Newest first: a thread keeps one loader at a time, but a stale row from an
 * earlier turn (its clear refused) can still sit beside the live one until
 * the sweep takes it; the live turn is always the latest to go up.
 */
/** Where a Stop says the loader is: the native loader's thread root, or
 * the narration card's own message. */
export type LoaderAddress =
  | { presenceId: string; channel: string; threadTs: string }
  | { presenceId: string; channel: string; cardTs: string };

export const findSessionTurn = async (
  address: LoaderAddress,
): Promise<string | null> => {
  const receipt = await db.channelTurnReceipt.findFirst({
    where: {
      agentChannelId: address.presenceId,
      channel: address.channel,
      kind: "session",
      ...("threadTs" in address
        ? { messageTs: address.threadTs }
        : { cardTs: address.cardTs }),
    },
    orderBy: { createdAt: "desc" },
    select: { turnId: true },
  });
  return receipt?.turnId ?? null;
};

/**
 * Take a STOPPED session out of `processing`. The provider does not do this
 * itself when its Stop is clicked (Slack documents that the status stays
 * until the app moves it), and the stop must look instant even while the
 * abort is still reaching the sandbox: the turn's own close will clear the
 * row and post "Stopped." when it lands. Best-effort, never throws: a
 * refused status costs a loader that the close, or the provider's own
 * timeout, still takes down.
 */
export const settleStoppedSession = async (input: {
  presenceId: string;
  channel: string;
  threadTs: string;
}): Promise<void> => {
  try {
    const presence = await db.agentChannel.findUnique({
      where: { id: input.presenceId },
      select: { provider: true, credentials: true, appMode: true },
    });
    // Only an agent-flavor app has a session to settle (a regular app's
    // status call is refused for scope, and it never shows a Stop).
    if (presence?.appMode !== "agent") return;
    const provider = channelProvider(presence.provider as ChannelProviderId);
    if (!provider.setThreadWorkStatus) return;
    await provider.setThreadWorkStatus({
      credentialsJson: presence.credentials
        ? await getCrypto().decrypt(presence.credentials)
        : null,
      channel: input.channel,
      threadTs: input.threadTs,
      working: false,
    });
  } catch (err) {
    void noteOutboundFailure(input.presenceId, err);
    log.info(
      { err: String(err), presenceId: input.presenceId },
      "stopped session left processing",
    );
  }
};

/**
 * THE FOLLOW-UP'S OWN MARK: a mid-run message sent
 * while the agent works gets a reaction of its own the moment it is
 * accepted, and keeps it. One mark per message, never moved:
 *
 *   `hourglass_flowing_sand`   accepted, waiting for the agent to reach it
 *   `eyes`                     the agent has it (`markFollowUpRead`)
 *   (removed)                  the answer posted (`clearTurnReceipts`)
 *
 * No chooser call: the waiting mark is a fixed glyph with a fixed meaning,
 * and spending the customer's key on a pick per follow-up bought nothing a
 * reader could tell apart. A thread under a SESSION mark (the provider's
 * native loader, keyed on the running turn) gets no emoji: its waiting mark
 * is a row on the loader's card instead (`refreshTurnCard`), with the
 * author's Send now beside it, and the row leaves when the agent reads it.
 * The session receipt stays on the running turn, where the card and the
 * clear look.
 *
 * Detached and best-effort like every receipt write. The row is keyed by the
 * follow-up's own turn id, which is what the family clear walks (the turn
 * and its `joined` follow-ups), so the mark comes off with the answer.
 */
export const FOLLOW_UP_WAITING_REACTION = "hourglass_flowing_sand";
export const FOLLOW_UP_READ_REACTION = "eyes";

export const attachFollowUpReceipt = async (input: {
  presenceId: string;
  /** The follow-up row the mark belongs to. */
  followUpTurnId: string;
  channel: string;
  messageTs: string;
}): Promise<void> => {
  try {
    const presence = await db.agentChannel.findUnique({
      where: { id: input.presenceId },
      select: { id: true, provider: true, credentials: true },
    });
    if (!presence) return;

    // The target is the RUNNING turn, which is where a session mark sits
    // (it never moves off the run): one lookup says whether the thread's
    // loader already covers this message. When it does, the message's mark
    // is its row on the loader's card (with its Send now), not an emoji.
    const followUp = await db.turn.findUnique({
      where: { id: input.followUpTurnId },
      select: { followUpOfTurnId: true },
    });
    if (!followUp?.followUpOfTurnId) return;
    const loader = await db.channelTurnReceipt.findFirst({
      where: { turnId: followUp.followUpOfTurnId, kind: "session" },
      select: { id: true },
    });
    if (loader) {
      await refreshTurnCard(followUp.followUpOfTurnId);
      return;
    }

    try {
      await db.channelTurnReceipt.create({
        data: {
          turnId: input.followUpTurnId,
          agentChannelId: presence.id,
          channel: input.channel,
          messageTs: input.messageTs,
          kind: "reaction",
          reaction: FOLLOW_UP_WAITING_REACTION,
        },
        select: { id: true },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        return; // a twin already marked this follow-up: its mark stands
      }
      throw err;
    }
    pruneOldReceipts(presence.id);

    const credentialsJson = presence.credentials
      ? await getCrypto().decrypt(presence.credentials)
      : null;
    const provider = channelProvider(presence.provider as ChannelProviderId);
    await provider.addReceiptReaction({
      credentialsJson,
      channel: input.channel,
      messageTs: input.messageTs,
      reaction: FOLLOW_UP_WAITING_REACTION,
    });
    // The same race as the turn's own attach: the answer may have posted
    // (and its clear no-oped) while the mark was landing.
    await selfClearIfTurnFinished(input.followUpTurnId);
  } catch (err) {
    void noteOutboundFailure(input.presenceId, err);
    log.warn(
      { err: String(err), followUpTurnId: input.followUpTurnId },
      "follow-up receipt add skipped",
    );
  }
};

/**
 * The agent has the message (the live pickup signal, `message.joined`):
 * swap the follow-up's waiting mark for the read mark. New mark on first,
 * old mark off second, so a crash between the two leaves both (converged by
 * the answer-post clear) rather than none. Idempotent: a row already read,
 * or one that never had the waiting mark (a session thread, a web-sourced
 * follow-up with no receipt), changes nothing.
 */
export const markFollowUpRead = async (
  followUpTurnId: string,
): Promise<void> => {
  try {
    const receipt = await db.channelTurnReceipt.findFirst({
      where: {
        turnId: followUpTurnId,
        kind: "reaction",
        reaction: FOLLOW_UP_WAITING_REACTION,
      },
      select: {
        id: true,
        channel: true,
        messageTs: true,
        agentChannel: {
          select: { id: true, provider: true, credentials: true },
        },
      },
    });
    if (!receipt) return;

    const credentialsJson = receipt.agentChannel.credentials
      ? await getCrypto().decrypt(receipt.agentChannel.credentials)
      : null;
    const provider = channelProvider(
      receipt.agentChannel.provider as ChannelProviderId,
    );
    await provider.addReceiptReaction({
      credentialsJson,
      channel: receipt.channel,
      messageTs: receipt.messageTs,
      reaction: FOLLOW_UP_READ_REACTION,
    });
    // The ledger flips BEFORE the old mark comes off: a clear racing in
    // between then removes the read mark (what the row says), and the
    // waiting mark is taken off right here, so nothing is left behind.
    // Conditional on the row still holding the waiting mark: a clear that
    // won in between (the answer posted as the join landed) already took
    // the waiting mark off and deleted the row, and the read mark just
    // added would outlive the exchange. A row flipped by a twin stands.
    const flipped = await db.channelTurnReceipt.updateMany({
      where: { id: receipt.id, reaction: FOLLOW_UP_WAITING_REACTION },
      data: { reaction: FOLLOW_UP_READ_REACTION },
    });
    if (flipped.count === 0) {
      const row = await db.channelTurnReceipt.findUnique({
        where: { id: receipt.id },
        select: { id: true },
      });
      if (row) return; // a twin flipped it: its read mark stands
      log.info(
        { followUpTurnId },
        "answer cleared the mark as it flipped; taking the read mark off",
      );
      await provider.removeReceiptReaction({
        credentialsJson,
        channel: receipt.channel,
        messageTs: receipt.messageTs,
        reaction: FOLLOW_UP_READ_REACTION,
      });
      return;
    }
    await provider.removeReceiptReaction({
      credentialsJson,
      channel: receipt.channel,
      messageTs: receipt.messageTs,
      reaction: FOLLOW_UP_WAITING_REACTION,
    });
  } catch (err) {
    log.warn(
      { err: String(err), followUpTurnId },
      "follow-up read mark skipped",
    );
  }
};
