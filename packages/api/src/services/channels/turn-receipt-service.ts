import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../../providers";
import { channelProvider } from "./registry";
import { chooseReaction } from "./reaction-chooser";
import { ChannelProviderApiError } from "./errors";
import type { ChannelProvider, ChannelProviderId } from "./types";
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
            // never the turn.
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

/** A session loader older than this is presumed leaked (a real turn's clear
 * lands in seconds; long runs re-signal by finishing). Well under Slack's 1h
 * session timeout — the sweep's whole point is beating it. */
const STALE_SESSION_MS = 10 * 60 * 1000;

/** Bounded per pass: the sweep rides a hot poll path; a pathological backlog
 * drains over successive passes instead of stalling one. */
const STALE_SESSION_SWEEP_LIMIT = 20;

/**
 * The guarantee behind the recheck: any session loader that slipped every
 * fast-path clear (a crash between the provider call and the row insert, a
 * refused clear, a future regression of the terminal-before-clear invariant)
 * is set back to rest within minutes, not Slack's hour. Deliberately
 * session-only — stale REACTION rows are cosmetic and the 24h prune owns
 * them. Best-effort per row: a failed provider call keeps the row for the
 * next pass; the delete happens only after the provider acknowledged.
 */
export const sweepStaleSessionReceipts = async (): Promise<void> => {
  try {
    const stale = await db.channelTurnReceipt.findMany({
      where: {
        kind: "session",
        createdAt: { lt: new Date(Date.now() - STALE_SESSION_MS) },
      },
      orderBy: { createdAt: "asc" },
      take: STALE_SESSION_SWEEP_LIMIT,
      select: { turnId: true },
    });
    for (const row of stale) {
      log.warn({ turnId: row.turnId }, "stale session loader; sweeping clear");
      await clearTurnReceipt(row.turnId);
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
 * NARRATE the turn's current activity on its own card beside the
 * conversation — one row per tool call, the newest running.
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
    const receipt = await db.channelTurnReceipt.findFirst({
      where: { turnId, kind: "session" },
      select: {
        id: true,
        channel: true,
        messageTs: true,
        cardThreadTs: true,
        cardTs: true,
        cardSteps: true,
        cardRev: true,
        cardAt: true,
        agentChannel: { select: { provider: true, credentials: true } },
      },
    });
    // No session receipt = nothing to narrate onto (a reaction fallback, or
    // a turn whose loader already came down). Not a problem.
    if (!receipt) return;
    // The same step repeated: the card already says this, and rewriting it
    // with itself would spend Slack's rate limit on nothing.
    if (receipt.cardSteps.at(-1) === activity) return;
    // THROTTLE. Repeat-suppression alone bounds nothing: an agent
    // alternating two tools changes the step every call, and a fast turn can
    // pass Slack's ceiling and start collecting 429s. A step that appears a
    // beat late is invisible to a reader; a rate-limited channel is not.
    if (
      receipt.cardAt &&
      Date.now() - receipt.cardAt.getTime() < NARRATION_MIN_INTERVAL_MS
    ) {
      return;
    }

    const provider = channelProvider(
      receipt.agentChannel.provider as ChannelProviderId,
    );
    if (!provider.narrateThreadWork) return;

    const steps = [...receipt.cardSteps, activity].slice(-NARRATION_MAX_STEPS);

    // RESERVE the step before talking to the provider, and let that write
    // be what excludes a rival. The route pushes narration detached, so two
    // batches for one turn can be in flight together; writing the list here
    // (not after the call) means the second caller reads the first's step
    // and APPENDS to it rather than racing it — the card grows, it never
    // rewinds.
    //
    // The revision is bumped for the posting rule below, which is the one
    // window this ordering cannot cover on its own.
    await db.channelTurnReceipt.updateMany({
      where: { id: receipt.id },
      data: { cardSteps: steps, cardAt: new Date(), cardRev: { increment: 1 } },
    });

    // POSTING is exclusive, and reserving the step does not make it so:
    // `cardTs` is written only once the provider answers, so a caller
    // arriving during that round-trip still reads null and would post a
    // SECOND card. The first writer (the one that found revision 0) posts;
    // everyone else waits for the handle rather than racing it.
    if (receipt.cardTs === null && receipt.cardRev > 0) return;

    const credentialsJson = receipt.agentChannel.credentials
      ? await getCrypto().decrypt(receipt.agentChannel.credentials)
      : null;

    const result = await provider.narrateThreadWork({
      credentialsJson,
      channel: receipt.channel,
      // A group thread's card belongs in that thread; a DM has none, and
      // passing null is what keeps the card inline instead of opening a
      // thread nobody asked for.
      threadTs: receipt.cardThreadTs,
      activities: steps,
      cardTs: receipt.cardTs,
    });
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
  } catch (err) {
    // A PROVIDER refusal is routine (plan-gated workspace, dead credential)
    // and stays at info: the loader is untouched and there is nothing to
    // fix. A fault on OUR side is not routine — it means narration is
    // broken for everyone, and swallowing it at the same level is how a
    // missing column looked exactly like a Slack refusal for a whole
    // afternoon (observed 2026-08-31). Same swallow, louder record.
    const providerRefusal = err instanceof ChannelProviderApiError;
    const line = "activity narration skipped; the loader stands";
    if (providerRefusal) log.info({ err: String(err), turnId }, line);
    else log.error({ err: String(err), turnId }, line);
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
 * MOVE the conversation's seen-mark to the newest message (the mid-run
 * follow-up that just arrived): remove the reaction from wherever it sits —
 * the target turn's message or an earlier follow-up's — and attach the SAME
 * emoji to the new one. Reusing the previous reaction is deliberate: no
 * second chooser inference per follow-up, and the mark visibly travels
 * instead of mutating. A SESSION mark doesn't travel at all — the thread's
 * loader already covers every message in it, and the row stays on the turn
 * that is RUNNING, which is both where the clear looks (it walks the turn
 * and its joined follow-ups) and where the narration card is keyed. Detached
 * and best-effort like every receipt write; two rapid follow-ups' moves can
 * interleave into a transient double-mark until the answer-post clear
 * converges them — bounded, cosmetic, accepted.
 */
export const moveTurnReceipt = async (input: {
  presenceId: string;
  /** The follow-up row: the reaction mark's new owner, and the excluded id
   * when resolving where the current mark sits. A SESSION mark does not
   * change owner — see the session arm below. */
  followUpTurnId: string;
  /** The conversation whose seen-mark is moving. */
  conversationId: string;
  channel: string;
  messageTs: string;
  /** The session root — threaded through so a no-mark fallback attach can
   * still choose the session kind. Null only when the caller has none. */
  threadTs?: string | null;
  /** Where a narration card belongs, for the no-mark fallback below — the
   * same field `attachTurnReceipt` takes. Carried rather than re-derived so
   * a follow-up that falls through to an attach lands its card in the same
   * thread its own turn would have. */
  replyThreadTs?: string | null;
  /** Whether there is no thread to hang a loader on, for that same fallback.
   * Omitted keeps `attachTurnReceipt`'s own default. */
  unthreaded?: boolean;
  /** The inbound text — chooser input only when no mark exists to move. */
  text: string;
}): Promise<void> => {
  try {
    // Resolve where the mark currently sits. `ChannelTurnReceipt` has no
    // conversation column (and no Turn FK) on purpose, so the family is
    // resolved through the conversation's own recent turns — which also
    // survives promotion chains, where the mark can sit on a follow-up of a
    // follow-up rather than on this one's direct target. Bounded recency:
    // marks live for one exchange and are pruned at 24h regardless.
    const candidateIds = (
      await db.turn.findMany({
        where: {
          conversationId: input.conversationId,
          id: { not: input.followUpTurnId },
        },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { id: true },
      })
    ).map((row) => row.id);

    const current = await db.channelTurnReceipt.findFirst({
      where: { turnId: { in: candidateIds } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        turnId: true,
        channel: true,
        messageTs: true,
        kind: true,
        reaction: true,
        workStatusSet: true,
        agentChannel: {
          select: { id: true, provider: true, credentials: true },
        },
      },
    });

    if (!current) {
      // Nothing to move (a web-opened turn never had a mark): fall back to
      // the ordinary attach, chooser and all — with the SAME addressing its
      // own turn would have had, so a threaded follow-up's card opens in its
      // thread rather than at the top of the conversation.
      await attachTurnReceipt({
        presenceId: input.presenceId,
        turnId: input.followUpTurnId,
        channel: input.channel,
        messageTs: input.messageTs,
        threadTs: input.threadTs,
        replyThreadTs: input.replyThreadTs,
        ...(input.unthreaded !== undefined && { unthreaded: input.unthreaded }),
        text: input.text,
      });
      return;
    }

    if (current.kind === "session") {
      // The row STAYS on the turn it was attached to. Nothing moves
      // provider-side (the thread's loader already covers the follow-up's
      // message), and nothing moves ledger-side either.
      //
      // It used to be re-keyed to the follow-up, on the reasoning that the
      // clear "fires off the newest turn's id". That reasoning was wrong in
      // one direction and load-bearing in the other:
      //
      // - The clear fires off the FINISHED turn's id — the mirror passes
      //   `item.turn.id` (routes/channel-adapter.ts), and `clearTurnReceipts`
      //   then walks that turn AND its `joined` follow-ups. A row left here is
      //   found either way, so the re-key bought nothing.
      // - The narration card is keyed by turn id, and the supervisor reports
      //   tool activity under the turn it is RUNNING: a steer never moves
      //   `runtime.activeTurnId` (apps/sandbox-supervisor). Re-keying moved
      //   the receipt out from under `narrateTurnActivity`, whose lookup then
      //   missed and returned silently — so a mid-run follow-up showed a
      //   frozen card, or in a top-level DM no card at all, for the rest of
      //   the turn (live 2026-09-02).
      //
      // Keeping the row where the narration looks for it is what fixes that,
      // and it is also the simpler invariant: a session receipt belongs to
      // the run, not to the last message that joined it.
      //
      // The self-clear still runs, against the row's OWN turn: the same
      // attach-vs-clear race applies here (a clear that fired between the
      // lookup above and now would have found nothing to do), and the
      // follow-up's arrival is exactly when the parent may have just
      // finished.
      await selfClearIfTurnFinished(current.turnId);
      return;
    }
    if (!current.reaction) return; // malformed row — nothing to move
    const reaction = current.reaction;

    const credentialsJson = current.agentChannel.credentials
      ? await getCrypto().decrypt(current.agentChannel.credentials)
      : null;
    const provider = channelProvider(
      current.agentChannel.provider as ChannelProviderId,
    );

    // New mark FIRST, old mark off second: a crash in between leaves two
    // marks (converged by the answer-post clear) rather than none — a
    // vanished ack reads as a drop, which is the exact perception this
    // feature kills.
    try {
      await db.channelTurnReceipt.create({
        data: {
          turnId: input.followUpTurnId,
          agentChannelId: current.agentChannel.id,
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
        return; // a twin already moved for this follow-up — its mark stands
      }
      throw err;
    }
    await provider.addReceiptReaction({
      credentialsJson,
      channel: input.channel,
      messageTs: input.messageTs,
      reaction,
    });

    await provider.removeReceiptReaction({
      credentialsJson,
      channel: current.channel,
      messageTs: current.messageTs,
      reaction,
    });
    await db.channelTurnReceipt.delete({ where: { id: current.id } });
    // Same race window as attach: the answer may have posted (and its clear
    // no-oped) while the marks were being shuffled.
    await selfClearIfTurnFinished(input.followUpTurnId);
  } catch (err) {
    log.warn(
      { err: String(err), followUpTurnId: input.followUpTurnId },
      "receipt move skipped",
    );
  }
};
