import { db } from "@onecli/db";
import type { Prisma } from "@onecli/db";
import { getEventBus } from "../providers/event-bus";
import type { PublishedEvent } from "./event-bus";

/**
 * THE DURABLE NOTICE: one platform-authored line on a conversation, anchored
 * to a turn, visible in the web transcript live and read by the model's
 * next-turn context. This is the ONE way a service tells a conversation
 * something happened outside the model's own output (an approval settled, a
 * mention failed, a peer agent was messaged) — previously three copies of
 * the same transaction (action approvals, mention failures, and now the
 * agent link service), now one seam.
 *
 * The write is a transaction on the conversation row: the atomic `lastSeq`
 * increment hands out the transcript cursor (the same monotonic order every
 * turn event uses, so a tailing reader never misses it), then the event row
 * lands under that seq. `extra` rides in the payload for structured readers
 * (the context-note builders) and is ignored by the canonical notice shape.
 *
 * Best-effort by contract: a notice that cannot be written (the conversation
 * vanished) answers `false`; callers log and move on - the state it
 * describes is already durable elsewhere.
 */
export const writeConversationNotice = async (input: {
  conversationId: string;
  turnId: string;
  level: "info" | "warn";
  text: string;
  /** Structured fields for the next turn's context note, merged into the
   * event payload beside `type`/`level`/`text`. */
  extra?: Record<string, Prisma.InputJsonValue>;
}): Promise<boolean> => {
  const published = await db.$transaction(
    async (tx): Promise<PublishedEvent[] | null> => {
      const conversation = await tx.conversation.findUnique({
        where: { id: input.conversationId },
        select: { id: true },
      });
      if (!conversation) return null;
      const { lastSeq } = await tx.conversation.update({
        where: { id: input.conversationId },
        data: { lastSeq: { increment: 1 } },
        select: { lastSeq: true },
      });
      const event = {
        type: "notice" as const,
        level: input.level,
        text: input.text,
        ...(input.extra ?? {}),
      };
      await tx.turnEvent.create({
        data: {
          conversationId: input.conversationId,
          turnId: input.turnId,
          seq: lastSeq,
          type: "notice",
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });
      return [{ seq: lastSeq, turnId: input.turnId, type: "notice", event }];
    },
  );
  if (!published) return false;
  getEventBus().publish(input.conversationId, published);
  return true;
};
