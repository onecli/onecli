import { db } from "@onecli/db";
import type { Prisma } from "@onecli/db";
import { z } from "zod";
import { logger } from "../../lib/logger";
import { CONVERSATION_SOURCES } from "../../validations/conversation";
import { sendConversationMessage } from "../follow-up-service";
import {
  decideActionApproval,
  registerActionHandler,
  requestActionApproval,
} from "./action-approval-service";
import { resolvePersonReach, resolveSpaceReach } from "./agent-reach-service";
import { channelProvider } from "./registry";
import type { ChannelProviderId } from "./types";

const log = logger.child({ service: "app-turn-cap" });

/**
 * THE APP-TURN CAP (PR 5a) — the one thing apps add to the human gate.
 *
 * Apps ride the exact same channel gate people do; what they lack is the
 * capacity to get bored, so two automations in one thread can answer each
 * other forever. The first line of defense is addressing (an app is heard
 * only when it tags the agent - dispatch.ts); this service is the backstop
 * behind it, bounding a thread with ONE number per conversation:
 * consecutive app-authored turns admitted since the last human turn.
 *
 *  - An admitted app turn increments it. Any human turn resets it to 0.
 *    The count lands AFTER the turn does (`countAppTurn`): a message that
 *    never became a turn - a follow-up-cap refusal, a thrown create - costs
 *    nothing (the nanoclaw `onAccepted` lesson, 2026-09-08).
 *  - No timer. People meter loops by being present: a human-driven thread
 *    costs nothing, a runaway costs at most `APP_TURN_CAP` turns, total.
 *  - The crossing is EXACTLY ONCE, claimed by one conditional write (streak
 *    = cap -> cap + 1): the claimant parks its message in a hold (the
 *    action-approval primitive), the thread hears one pause line, and the
 *    owner's card asks whether the conversation may continue. A racer that
 *    lost the claim, and every later app message while paused, is silence —
 *    answering an app with text is a loop seed, so the door says nothing.
 *  - Approving = ONE MORE ROUND, never forever (decided 2026-09-08): the
 *    streak resets to 0 and the parked message replays as a turn, so the
 *    agent answers it with nobody typing again. When the cap is hit again,
 *    a fresh card asks again. Only the crossing message is parked; an
 *    expired card expires it with it. The replay re-asks the LIVE gate
 *    first (channel still open to everyone, app not blocked since the
 *    card): a card may sit for a day, and approving it must not admit what
 *    the room has since closed - the 4a/4e verify-at-approve lesson.
 *  - A PAIR conversation (PR 5b, two agents) has no human turn of its own,
 *    so "since the last human turn" needs a second reading of "a person is
 *    in the loop": a person driving one of the agents (`resetPairStreaks`,
 *    called by the agent link service when a `message_agent` comes from a
 *    running human-authored turn), or the owner resuming from the dashboard
 *    (`resumeAppTurns`, the peer row's Resume). The dashboard reads the
 *    pause (`isPastAppTurnCap`) so a paused pair is never a silent one.
 */

/** The house rule, not config: enough for a real back-and-forth, cheap to
 * burn if it loops. */
export const APP_TURN_CAP = 6;

/** The registered action: approve = one more round + replay. */
export const APP_TURN_CONTINUE_ACTION = "channel.continue_app_conversation";

/** The one line the thread hears at the crossing (decided B, 2026-09-07):
 * bare mechanism, spoken exactly when it applies. Deliberately mention-free:
 * another agent in the room hears it as an un-addressed app post and the
 * dispatcher drops it before any door - two paused agents cannot wake each
 * other with their pause lines. */
export const APP_TURN_PAUSE_MESSAGE = "Paused until a person replies here.";

/**
 * The frozen hold: the row is the single truth (the 4b contract). `message`
 * is the framed, decoded text that hit the cap; `source` is where the
 * replayed turn is attributed to; `speaker` is who hit the cap - a Slack
 * APP (its bot user id, re-checked against the person ledger at replay) or
 * a PEER AGENT (its agent id, re-checked against the agent link). Either
 * way a block after the card must still win.
 */
const capSpeakerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("app"), externalRef: z.string().min(1) }),
  z.object({ kind: z.literal("agent"), agentId: z.string().min(1) }),
]);
export type CapSpeaker = z.infer<typeof capSpeakerSchema>;

const continuePayloadSchema = z.object({
  conversationId: z.string().min(1),
  message: z.string(),
  source: z.enum(CONVERSATION_SOURCES),
  speaker: capSpeakerSchema,
});
type ContinuePayload = z.infer<typeof continuePayloadSchema>;

type AppTurnVerdict = "admit" | "pause" | "silence";

/** Longest slice of the thread title the card carries: enough to recognize
 * the thread, short enough to stay one line. */
const CARD_TITLE_CHARS = 60;

/**
 * The card's one line, rendered by the shared template as
 * "<agent> asks: *<summary>*". Plain words, no counts: the owner should
 * understand they are letting the conversation go on for a while longer.
 */
const continueSummary = (title: string | null, speaker: CapSpeaker): string => {
  const where = title
    ? `"${title.length > CARD_TITLE_CHARS ? `${title.slice(0, CARD_TITLE_CHARS)}…` : title}"`
    : "this thread";
  return speaker.kind === "agent"
    ? `continue the conversation with ${where}`
    : `continue the conversation with other apps in ${where}`;
};

/**
 * Decide what the door owes one app-authored message, WITHOUT counting it:
 * `admit` = create the turn (then `countAppTurn` once it lands); `pause` =
 * this caller crossed the cap - post `APP_TURN_PAUSE_MESSAGE` once, the
 * card is out; `silence` = ignore. Called before anything is fetched or
 * created for the message, so a paused one costs nothing.
 */
export const admitAppTurn = async (input: {
  agentId: string;
  conversationId: string;
  source: ContinuePayload["source"];
  message: string;
  speaker: CapSpeaker;
}): Promise<AppTurnVerdict> => {
  const { appTurnStreak, title } = await db.conversation.findUniqueOrThrow({
    where: { id: input.conversationId },
    select: { appTurnStreak: true, title: true },
  });
  if (appTurnStreak < APP_TURN_CAP) return "admit";
  if (appTurnStreak > APP_TURN_CAP) return "silence";

  // At the cap: THE CROSSING CLAIM. One conditional write is the atomic
  // seam - it moves the streak to cap + 1 only if it still reads cap.
  // Exactly one racer sees count 1; the loser (or a message arriving after
  // a human/approve reset landed) re-reads on its own next message.
  const claim = await db.conversation.updateMany({
    where: { id: input.conversationId, appTurnStreak: APP_TURN_CAP },
    data: { appTurnStreak: { increment: 1 } },
  });
  if (claim.count === 0) return "silence";

  const payload: ContinuePayload = {
    conversationId: input.conversationId,
    message: input.message,
    source: input.source,
    speaker: input.speaker,
  };
  try {
    await requestActionApproval({
      agentId: input.agentId,
      conversationId: input.conversationId,
      action: APP_TURN_CONTINUE_ACTION,
      // Structurally JSON (four strings) — the cast bridges TS's nominal
      // InputJsonValue only.
      payload: payload as unknown as Prisma.InputJsonValue,
      summary: continueSummary(title, input.speaker),
    });
  } catch (err) {
    // The pause still stands (the counter did) — only the card is owed and
    // missing. Logged, not thrown: the door must answer the thread.
    log.warn(
      { err: String(err), conversationId: input.conversationId },
      "app-turn continue card could not be requested",
    );
  }
  return "pause";
};

/**
 * An app turn LANDED (turn or follow-up): count it. The `lt` guard keeps a
 * racing admit from pushing past the cap without a crossing - the streak
 * parks at the cap and the next message's claim is the one that crosses.
 */
export const countAppTurn = async (conversationId: string): Promise<void> => {
  await db.conversation.updateMany({
    where: { id: conversationId, appTurnStreak: { lt: APP_TURN_CAP } },
    data: { appTurnStreak: { increment: 1 } },
  });
};

/**
 * A human spoke in this conversation: the chain is broken. A no-op write
 * when already 0, so a busy human thread never touches the row.
 */
export const resetAppTurnStreak = async (
  conversationId: string,
): Promise<void> => {
  await db.conversation.updateMany({
    where: { id: conversationId, appTurnStreak: { gt: 0 } },
    data: { appTurnStreak: 0 },
  });
};

/**
 * Past the crossing: the conversation is paused and every app message to
 * it is silence until a person continues it. AT the cap is still open (the
 * next message is the one that crosses). The one place the threshold is
 * read for display, so the dashboard and the door agree.
 */
export const isPastAppTurnCap = (appTurnStreak: number): boolean =>
  appTurnStreak > APP_TURN_CAP;

/**
 * The dashboard's RESUME (PR 5b, the peer row): a person continues a paused
 * conversation from the web, with no card in hand. If the crossing's
 * continue card is still pending, this IS its approve - the same live gate,
 * the same one-round reset, the parked message replays, the bell and any
 * Slack cards settle - so the two doors can never disagree. Otherwise (the
 * card was rejected or expired, or the pause is older than the card) the
 * streak simply resets and the next message is admitted. Fenced on the
 * caller's agent owning the conversation. `false` = not-found.
 */
export const resumeAppTurns = async (input: {
  agentId: string;
  conversationId: string;
  deciderUserId: string;
}): Promise<boolean> => {
  const conversation = await db.conversation.findFirst({
    where: { id: input.conversationId, agentId: input.agentId },
    select: { id: true },
  });
  if (!conversation) return false;
  const card = await db.actionApproval.findFirst({
    where: {
      agentId: input.agentId,
      action: APP_TURN_CONTINUE_ACTION,
      status: "pending",
      payload: { path: ["conversationId"], equals: input.conversationId },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (card) {
    const decided = await decideActionApproval({
      approvalId: card.id,
      decision: "approve",
      deciderUserId: input.deciderUserId,
    });
    // `decided` covers executed AND failed (the live gate refused): a
    // failed approve leaves the pause standing on purpose, and the card
    // says why. Only a card that vanished under us falls through to the
    // bare reset.
    if (decided.kind === "decided") return true;
  }
  await resetAppTurnStreak(input.conversationId);
  return true;
};

/**
 * A PERSON is driving one of the two agents in a pair (PR 5b): the chain
 * of unattended agent turns is broken on BOTH sides of the pair, exactly as
 * a human turn in a Slack thread breaks it there. Called by the agent link
 * service before a delivery whose origin is a running, human-authored turn;
 * the delivered message then counts as the first of a fresh chain.
 */
export const resetPairStreaks = async (
  agentAId: string,
  agentBId: string,
): Promise<void> => {
  await db.conversation.updateMany({
    where: {
      source: "agent",
      appTurnStreak: { gt: 0 },
      OR: [
        { agentId: agentAId, externalRef: agentBId },
        { agentId: agentBId, externalRef: agentAId },
      ],
    },
    data: { appTurnStreak: 0 },
  });
};

/**
 * The live gate, re-asked at approve time. The card may have waited a day;
 * the room may have closed since. Throws the honest reason - the approval
 * then settles `failed` ("Approved but FAILED: ...") and nothing resumes.
 * Fenced on the approval's own agent: a foreign conversation id reads as
 * unlinked, never as a lookup.
 */
const verifyContinueStillAllowed = async (
  agentId: string,
  conversationId: string,
  speaker: CapSpeaker,
): Promise<void> => {
  if (speaker.kind === "agent") {
    // A peer agent's thread: the live gate is the agent link, both sides.
    const { isLinkBlocked } = await import("./agent-link-service");
    if (await isLinkBlocked(agentId, speaker.agentId)) {
      throw new Error("one side has blocked this conversation since");
    }
    return;
  }
  const link = await db.channelThreadLink.findFirst({
    where: { conversationId, conversation: { agentId } },
    select: {
      externalThreadId: true,
      agentChannel: { select: { integrationId: true, provider: true } },
    },
  });
  if (!link) throw new Error("the thread is no longer linked to a channel");
  const reach = channelProvider(
    link.agentChannel.provider as ChannelProviderId,
  ).reach;
  if (!reach) throw new Error("this channel provider has no reach facet");
  const scope = {
    agentId,
    integrationId: link.agentChannel.integrationId,
  };
  const space = await resolveSpaceReach({
    ...scope,
    externalRef: reach.spaceOf(link.externalThreadId),
  });
  if (space !== "approved") {
    throw new Error("the channel is no longer open to everyone");
  }
  const person = await resolvePersonReach({
    ...scope,
    externalRef: speaker.externalRef,
  });
  if (person === "blocked" || person === "members_only") {
    throw new Error("the workspace owner has blocked this app");
  }
};

/**
 * Approve = verify + one more round + replay. The live gate first (above),
 * then the streak resets (durable even if the replay fails), then the parked
 * message becomes a turn through the same send door the ingestion path uses
 * — a system-origin turn (`userId: null`, the guest posture) in a sourced
 * conversation. Fenced on the approval's OWN agent: the payload names the
 * conversation, the row says whose it must be, and a disagreement is a
 * not-found, never a write. No always-allow hook: the decision is one round,
 * never standing.
 */
registerActionHandler(APP_TURN_CONTINUE_ACTION, async (approval) => {
  const payload = continuePayloadSchema.parse(approval.payload);
  await verifyContinueStillAllowed(
    approval.agentId,
    payload.conversationId,
    payload.speaker,
  );
  const { count } = await db.conversation.updateMany({
    where: { id: payload.conversationId, agentId: approval.agentId },
    data: { appTurnStreak: 0 },
  });
  if (count === 0) throw new Error("the thread no longer exists");
  const agent = await db.agent.findUniqueOrThrow({
    where: { id: approval.agentId },
    select: { workspaceId: true },
  });
  await sendConversationMessage(
    agent.workspaceId,
    payload.conversationId,
    payload.message,
    { source: payload.source, userId: null },
  );
});
