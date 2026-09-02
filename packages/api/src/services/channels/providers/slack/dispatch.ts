import { db } from "@onecli/db";
import {
  ingestDirectMessage,
  ingestGroupMessage,
  ingestGroupInvite,
  ingestGroupLeave,
  type IngestOutcome,
  type GroupInviteOutcome,
} from "../../channel-ingestion-service";
import { attachTurnReceipt, moveTurnReceipt } from "../../turn-receipt-service";
import { interpretSlackEvent, type SlackDoorCall } from "./interpret";

/**
 * Raw Slack event → interpreted door call → outcome, for BOTH transports:
 * the HTTP events route and the socket adapter's ingest endpoint hand events
 * here so classification, the echo guard, and the fences run identically
 * whichever way the event arrived.
 */

export type SlackDispatchResult =
  | { kind: "ignored"; reason: string }
  | {
      kind: "message";
      call: Extract<SlackDoorCall, { door: "direct" | "group" }>;
      outcome: IngestOutcome;
    }
  | {
      kind: "invite";
      call: Extract<SlackDoorCall, { door: "invite" }>;
      outcome: GroupInviteOutcome;
    };

export const dispatchSlackEvent = async (input: {
  presenceId: string;
  identityRef: string | null;
  event: unknown;
  eventId: string;
}): Promise<SlackDispatchResult> => {
  const call = interpretSlackEvent(input.event, {
    botUserId: input.identityRef,
  });

  if (call.door === "ignore") {
    return { kind: "ignored", reason: call.reason };
  }

  // No `email` is threaded through: the ingestion doors resolve the speaker
  // control-plane-side (existing link, else a provider-verified lookup with
  // the presence's own bot token). A caller-supplied email would be an
  // impersonation vector.
  if (call.door === "invite") {
    const outcome = await ingestGroupInvite({
      agentChannelId: input.presenceId,
      inviterExternalUserId: call.inviterExternalUserId,
      // The joined channel - the reach grant's subject (the owner-DM knock).
      channel: call.channel,
      eventId: input.eventId,
    });
    return { kind: "invite", call, outcome };
  }

  if (call.door === "leave") {
    // The bot was removed from the channel: presence cleanup, nothing owed
    // back (the bot cannot post there anymore). Ignored-shaped on the wire
    // by design - the adapter has nothing to do.
    await ingestGroupLeave({
      agentChannelId: input.presenceId,
      channel: call.channel,
      eventId: input.eventId,
    });
    return { kind: "ignored", reason: "left-channel-cleaned" };
  }

  if (call.door === "direct") {
    const outcome = await ingestDirectMessage({
      agentChannelId: input.presenceId,
      externalUserId: call.externalUserId,
      externalThreadId: call.externalThreadId,
      text: call.text,
      files: call.files,
      // The DM thread this was typed in, when it was typed in one. The
      // conversation stays the DM's single row; only the answer's address
      // narrows to the thread.
      sourceThreadId: call.replyThreadTs,
      eventId: input.eventId,
    });
    receiptForAcceptedTurn(input.presenceId, call, outcome);
    return { kind: "message", call, outcome };
  }

  // Group follow-ups (no mention) count only inside threads the agent
  // already joined — an existing link is the membership test. A mention
  // (`app_mention`) always counts and is what CREATES the link.
  const isMention = await isMentionOrJoinedThread(input, call);
  if (!isMention) {
    return { kind: "ignored", reason: "unjoined-thread-chatter" };
  }

  const outcome = await ingestGroupMessage({
    agentChannelId: input.presenceId,
    externalUserId: call.externalUserId,
    externalThreadId: call.externalThreadId,
    title: null,
    text: call.text,
    files: call.files,
    eventId: input.eventId,
  });
  receiptForAcceptedTurn(input.presenceId, call, outcome);
  return { kind: "message", call, outcome };
};

/**
 * The "seen" mark, detached: an ACCEPTED turn (created cleanly — a door
 * failure's error IS its answer, posted by the completion pass) gets an
 * AI-chosen reaction on the triggering message. An accepted mid-run
 * FOLLOW-UP moves the conversation's existing mark to its message instead —
 * the reaction visibly travels to the newest thing the agent has taken on.
 * Fire-and-forget by design: nothing here may delay the ack or change the
 * outcome, and the receipt ledger is what makes the later clear restart-safe.
 */
const receiptForAcceptedTurn = (
  presenceId: string,
  call: Extract<SlackDoorCall, { door: "direct" | "group" }>,
  outcome: IngestOutcome,
): void => {
  if (outcome.kind === "followUp") {
    void moveTurnReceipt({
      presenceId,
      followUpTurnId: outcome.turn.id,
      conversationId: outcome.conversationId,
      channel: call.replyChannel,
      messageTs: call.messageTs,
      // Same session-root rule as the attach below: an UNTHREADED DM's root
      // is the message that started the exchange. Kept identical on purpose
      // — the move's no-mark fallback calls `attachTurnReceipt`, so a
      // divergence here would give a follow-up a different session than its
      // own turn.
      threadTs: call.replyThreadTs ?? call.messageTs,
      // The card's home and the loader decision, identical to the attach
      // below — the fallback inside `moveTurnReceipt` calls it, so these
      // must not diverge.
      replyThreadTs: call.replyThreadTs,
      unthreaded: call.replyThreadTs === null,
      text: call.text,
    });
    return;
  }
  if (outcome.kind !== "turn" || outcome.turn.errorCode) return;
  void attachTurnReceipt({
    presenceId,
    turnId: outcome.turn.id,
    channel: call.replyChannel,
    messageTs: call.messageTs,
    // The session root the agent-flavor loader is keyed by.
    //
    // Anything THREADED — a group mention, or a DM reply typed inside a
    // thread — carries the thread root it will answer in. A top-level DM has
    // no thread, but Slack still requires a `thread_ts` to scope an agent
    // session (`thread_ts_required` otherwise), and the user's own message IS
    // a valid root: the session hangs off the message that started the
    // exchange, which is exactly the turn this receipt marks.
    //
    // This is what gives DMs the native loader at all. Before it they fell
    // through to the emoji reaction, which is a "seen" mark rather than a
    // "working" one — the agent looked idle for the whole turn.
    threadTs: call.replyThreadTs ?? call.messageTs,
    // Where a narration card may go: the real reply thread — the group
    // thread, the DM thread the person typed in, or null at the top level of
    // a DM. Kept apart from the session root above so an UNTHREADED DM's
    // card stays inline instead of opening a thread per turn.
    replyThreadTs: call.replyThreadTs,
    // No thread to hang a loader on ⇒ the card carries the whole signal.
    // Derived from the reply address rather than the door: a DM reply typed
    // INSIDE a thread has one, and it should light up like any other thread.
    unthreaded: call.replyThreadTs === null,
    text: call.text,
  });
};

/**
 * `app_mention` events always pass (they are addressed to the agent). A plain
 * thread message passes only when the thread is already linked.
 */
const isMentionOrJoinedThread = async (
  input: { presenceId: string; event: unknown },
  call: Extract<SlackDoorCall, { door: "group" }>,
): Promise<boolean> => {
  const type = (input.event as { type?: string }).type;
  if (type === "app_mention") return true;
  const link = await db.channelThreadLink.findUnique({
    where: {
      agentChannelId_externalThreadId: {
        agentChannelId: input.presenceId,
        externalThreadId: call.externalThreadId,
      },
    },
    select: { id: true },
  });
  return link !== null;
};
