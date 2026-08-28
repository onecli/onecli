import { db } from "@onecli/db";
import { ServiceError } from "./errors";
import {
  requireConversation,
  requireSystemConversation,
} from "./conversation-service";
import {
  createFollowUp,
  createTurn,
  promoteOldestParkedFollowUp,
  type TurnOrigin,
} from "./turn-service";
import { listConversationsWithParkedFollowUps } from "./due-work";
import {
  ACTIVE_TURN_STATUSES,
  FOLLOW_UP_CAP_MESSAGE,
  MAX_JOINING_FOLLOW_UPS,
} from "../validations/conversation";
import { logger } from "../lib/logger";

const log = logger.child({ component: "follow-up-service" });

/**
 * THE MESSAGE DOOR (mid-run follow-ups): say something to an agent whatever
 * it is doing. When the conversation is free this is `createTurn`; when a
 * turn is in flight the message becomes a follow-up row that steers into it —
 * never a 409, never a silent drop. Every human surface (web `POST
 * /conversations/:id/messages`, the channel ingestion doors) speaks through
 * here; automation (cron/watch) deliberately does not — a schedule must skip
 * a busy conversation, not steer into a human's live exchange.
 */

export type SendMessageOutcome =
  | { kind: "turn"; turn: Awaited<ReturnType<typeof createTurn>> }
  | { kind: "followUp"; turn: Awaited<ReturnType<typeof createFollowUp>> };

/**
 * Bounded retries: the active-turn read races sends, closes, and promotions,
 * and the partial unique index is the arbiter for all of them — a P2002 from
 * `createTurn` just means "someone occupied the conversation since we
 * looked", and the right response is to look again and follow up.
 */
const SEND_ATTEMPTS = 3;

const activeTurnOf = (conversationId: string) =>
  db.turn.findFirst({
    where: { conversationId, status: { in: [...ACTIVE_TURN_STATUSES] } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

export const sendConversationMessage = async (
  workspaceId: string,
  conversationId: string,
  message: string,
  origin: TurnOrigin,
  attachmentIds?: string[],
): Promise<SendMessageOutcome> => {
  // The same fence `createTurn` runs, up front and once: a caller must not
  // write into a direct thread they could not read, whichever arm serves
  // the message. (`createTurn` below re-runs it — one redundant indexed
  // read on the plain path, in exchange for no arm ever missing it.)
  const conversation =
    origin.userId === null
      ? await requireSystemConversation(workspaceId, conversationId)
      : await requireConversation(workspaceId, conversationId, origin.userId);

  for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt += 1) {
    let target = await activeTurnOf(conversation.id);

    if (!target) {
      // FIFO: an older parked follow-up must run before this newer message.
      // Promoting it here (instead of leaving it to the poll pass) both
      // preserves order and serves it immediately; this message then
      // follows up on the promoted turn like any other mid-run send.
      if (await promoteOldestParkedFollowUp(conversation.id)) {
        target = await activeTurnOf(conversation.id);
      } else {
        try {
          // The plain path: `createTurn` owns the title, the door-1
          // credential check, and the wake.
          const turn = await createTurn(
            workspaceId,
            conversationId,
            message,
            origin,
            attachmentIds,
          );
          return { kind: "turn", turn };
        } catch (err) {
          if (err instanceof ServiceError && err.code === "CONFLICT") {
            continue; // a racing send won the index — follow up on it
          }
          throw err;
        }
      }
    }
    if (!target) continue; // promotion settled instantly — look again

    // Bounds runaway queues, not exact fairness: two racing sends can both
    // read 9 and both land. Refused loudly on purpose — an invisible cap
    // refusal would be the silent-drop bug this door exists to kill.
    const parked = await db.turn.count({
      where: { conversationId: conversation.id, status: "joining" },
    });
    if (parked >= MAX_JOINING_FOLLOW_UPS) {
      throw new ServiceError("CONFLICT", FOLLOW_UP_CAP_MESSAGE);
    }

    const followUp = await createFollowUp(
      conversation.id,
      target.id,
      message,
      origin,
      attachmentIds,
    );

    // The target can close between the read and the create, and the close's
    // inline promotion ran before this row existed — self-serve instead of
    // waiting out the poll backstop. Cheap (one indexed read per send) and
    // rare (a milliseconds window).
    const stillActive = await db.turn.findFirst({
      where: { id: target.id, status: { in: [...ACTIVE_TURN_STATUSES] } },
      select: { id: true },
    });
    if (!stillActive) {
      await promoteOldestParkedFollowUp(conversation.id).catch((err: unknown) =>
        log.warn(
          { err, conversationId: conversation.id },
          "post-create promotion failed; the poll pass will retry",
        ),
      );
    }

    return { kind: "followUp", turn: followUp };
  }

  // Three straight lost races means the conversation is churning faster
  // than this door can read it — answer like the cap does rather than loop.
  throw new ServiceError("CONFLICT", FOLLOW_UP_CAP_MESSAGE);
};

/**
 * The promotion backstop, run from the work poll beside `fireDueCrons`
 * (§3.3: dueness at poll time, no background loop). The PRIMARY promotion
 * path is inline in `finishTurn` — this pass exists for everything that can
 * die between a close and its promotion: a crashed api instance, a settle
 * frame that never arrived, a door race. Not runner-fenced, like cron
 * firing: promotion is turn creation, whichever poller gets here first.
 */
export const promoteParkedFollowUps = async (): Promise<number> => {
  const conversationIds = await listConversationsWithParkedFollowUps();
  let promoted = 0;
  for (const conversationId of conversationIds) {
    try {
      if (await promoteOldestParkedFollowUp(conversationId)) promoted += 1;
    } catch (err) {
      log.warn({ err, conversationId }, "follow-up promotion pass failed");
    }
  }
  if (promoted > 0) log.info({ promoted }, "promoted parked follow-ups");
  return promoted;
};
