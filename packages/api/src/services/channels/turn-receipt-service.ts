import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../../providers";
import { channelProvider } from "./registry";
import { chooseReaction } from "./reaction-chooser";
import type { ChannelProviderId } from "./types";
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
  /** The group thread's ROOT ts (Slack: `thread_ts`) — the key the native
   * work-status is set on. Null for DMs, which never get the loader (they
   * answer top-level; a loader would rip the reply into a thread). */
  threadTs?: string | null;
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

    // Agent-flavor presence in a group thread: the native work-status IS the
    // ack. Try it first — on any refusal (plan-gated workspace, missing
    // scope, dead credential) fall through to the reaction, so the user
    // always sees SOMETHING move.
    if (
      presence.appMode === "agent" &&
      input.threadTs &&
      provider.setThreadWorkStatus
    ) {
      const threadTs = input.threadTs;
      let statusSet = false;
      try {
        await provider.setThreadWorkStatus({
          credentialsJson,
          channel: input.channel,
          threadTs,
          working: true,
        });
        statusSet = true;
        try {
          await db.channelTurnReceipt.create({
            data: {
              turnId: input.turnId,
              agentChannelId: presence.id,
              channel: input.channel,
              // The THREAD ROOT, not the message: it is the address the
              // clear must set the status back on.
              messageTs: threadTs,
              kind: "session",
              reaction: null,
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

    if (receipt.kind === "session") {
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
    } else if (receipt.reaction) {
      await provider.removeReceiptReaction({
        credentialsJson,
        channel: receipt.channel,
        messageTs: receipt.messageTs,
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
 * instead of mutating. A SESSION mark doesn't travel — the thread's loader
 * already covers every message in it — so the row is just re-keyed to the
 * follow-up turn (the clear must fire off the newest turn's id). Detached
 * and best-effort like every receipt write; two rapid follow-ups' moves can
 * interleave into a transient double-mark until the answer-post clear
 * converges them — bounded, cosmetic, accepted.
 */
export const moveTurnReceipt = async (input: {
  presenceId: string;
  /** The follow-up row — the receipt's new owner. */
  followUpTurnId: string;
  /** The conversation whose seen-mark is moving. */
  conversationId: string;
  channel: string;
  messageTs: string;
  /** The group thread's root ts — threaded through so a no-mark fallback
   * attach can still choose the session kind. Null for DMs. */
  threadTs?: string | null;
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
        agentChannel: {
          select: { id: true, provider: true, credentials: true },
        },
      },
    });

    if (!current) {
      // Nothing to move (a web-opened turn never had a mark): fall back to
      // the ordinary attach, chooser and all.
      await attachTurnReceipt({
        presenceId: input.presenceId,
        turnId: input.followUpTurnId,
        channel: input.channel,
        messageTs: input.messageTs,
        threadTs: input.threadTs,
        text: input.text,
      });
      return;
    }

    if (current.kind === "session") {
      // The thread loader already covers the follow-up's message — nothing
      // moves provider-side. Re-key the row to the follow-up turn so the
      // clear (which fires off the NEWEST turn's id on answer post) finds it.
      try {
        await db.channelTurnReceipt.update({
          where: { id: current.id },
          data: { turnId: input.followUpTurnId },
          select: { id: true },
        });
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          (err.code === "P2002" || err.code === "P2025")
        ) {
          return; // a twin already moved it (or cleared it) — either stands
        }
        throw err;
      }
      // The re-key races the exchange's clear exactly like an attach does:
      // a clear that fired between the lookup above and this write missed
      // the row under its new key.
      await selfClearIfTurnFinished(input.followUpTurnId);
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
