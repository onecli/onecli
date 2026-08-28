import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../../providers";
import { channelProvider } from "./registry";
import { chooseReaction } from "./reaction-chooser";
import type { ChannelProviderId } from "./types";
import { logger } from "../../lib/logger";

const log = logger.child({ component: "turn-receipts" });

/**
 * The reaction-receipt ledger (the "seen" mark): written by a detached task
 * after an ingest door accepts a turn, cleared by the cursor-advance that
 * gates the answer post. Everything here is best-effort and detached — a
 * receipt is cosmetic, so no failure may surface to an ingest ack or the
 * adapter's cursor call. Restart-safe by construction: the row IS the state,
 * and rows older than the prune window are deleted opportunistically (turns
 * whose cursor never advances — an agent deleted mid-turn — age out).
 */

const RECEIPT_PRUNE_MS = 24 * 60 * 60 * 1000;

export interface AttachReceiptInput {
  presenceId: string;
  turnId: string;
  /** Provider-opaque address of the USER's message (Slack: channel + ts). */
  channel: string;
  messageTs: string;
  /** The inbound message text — what the chooser picks against. */
  text: string;
}

/**
 * Choose the emoji, persist the receipt, and mark the provider message.
 * Called `void` from the dispatch layer AFTER the door answered — by then
 * the turn exists and the ack no longer depends on anything here.
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

    // Fire-and-forget prune: losing one pass costs nothing.
    db.channelTurnReceipt
      .deleteMany({
        where: {
          agentChannelId: presence.id,
          createdAt: { lt: new Date(Date.now() - RECEIPT_PRUNE_MS) },
        },
      })
      .catch(() => {});

    const credentialsJson = presence.credentials
      ? await getCrypto().decrypt(presence.credentials)
      : null;
    await channelProvider(
      presence.provider as ChannelProviderId,
    ).addReceiptReaction({
      credentialsJson,
      channel: input.channel,
      messageTs: input.messageTs,
      reaction,
    });
  } catch (err) {
    log.warn({ err: String(err), turnId: input.turnId }, "receipt add skipped");
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
        reaction: true,
        agentChannel: { select: { provider: true, credentials: true } },
      },
    });
    if (!receipt) return;

    const credentialsJson = receipt.agentChannel.credentials
      ? await getCrypto().decrypt(receipt.agentChannel.credentials)
      : null;
    await channelProvider(
      receipt.agentChannel.provider as ChannelProviderId,
    ).removeReceiptReaction({
      credentialsJson,
      channel: receipt.channel,
      messageTs: receipt.messageTs,
      reaction: receipt.reaction,
    });

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
 * instead of mutating. Detached and best-effort like every receipt write;
 * two rapid follow-ups' moves can interleave into a transient double-mark
 * until the answer-post clear converges them — bounded, cosmetic, accepted.
 */
export const moveTurnReceipt = async (input: {
  presenceId: string;
  /** The follow-up row — the receipt's new owner. */
  followUpTurnId: string;
  /** The conversation whose seen-mark is moving. */
  conversationId: string;
  channel: string;
  messageTs: string;
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
        text: input.text,
      });
      return;
    }

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
          reaction: current.reaction,
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
      reaction: current.reaction,
    });

    await provider.removeReceiptReaction({
      credentialsJson,
      channel: current.channel,
      messageTs: current.messageTs,
      reaction: current.reaction,
    });
    await db.channelTurnReceipt.delete({ where: { id: current.id } });
  } catch (err) {
    log.warn(
      { err: String(err), followUpTurnId: input.followUpTurnId },
      "receipt move skipped",
    );
  }
};
