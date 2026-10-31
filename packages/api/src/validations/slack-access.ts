import { z } from "zod";

/**
 * "Grant the agent access to act as you in Slack" requests: what
 * read_conversation / send_as_me answer (`needs_access`) when the verified
 * person asking has not connected their Slack, has not shared the
 * conversation, has writing off there, or must reconnect for writing. The
 * request is an ordinary action approval decided by that person only; the
 * chat card renders from this payload (server data, never agent text).
 */
export const SLACK_ACCESS_ACTION = "slack_access_request";

export const SLACK_ACCESS_REASONS = [
  "not_connected",
  "not_shared",
  "write_off",
  "reconnect_for_write",
] as const;
export type SlackAccessReason = (typeof SLACK_ACCESS_REASONS)[number];

/** Reasons the person resolves by connecting Slack (never by Approve). */
export const CONNECT_REASONS: ReadonlySet<SlackAccessReason> = new Set([
  "not_connected",
  "reconnect_for_write",
]);

export const slackAccessPayloadSchema = z.object({
  readerUserId: z.string().min(1),
  /** The reader's Slack id when connected (where a DM card can go). */
  readerExternalUserId: z.string().nullable(),
  agentId: z.string().min(1),
  kind: z.enum(["read", "write"]),
  reason: z.enum(SLACK_ACCESS_REASONS),
  /** What the agent asked for, as typed (null = no conversation named). */
  conversationQuery: z.string().nullable(),
  /** The conversation resolved at request time (with the reader's token),
   * when there was one: approve re-verifies it is still theirs. */
  conversationRef: z.string().nullable(),
  conversationLabel: z.string().nullable(),
  /** A write request's message, sent once approved. */
  text: z.string().min(1).max(4000).optional(),
  /** The write came from the person's own "Send as me" pick: once they
   * connect, it is sent without another card (see ConversationSender). */
  consented: z.boolean().optional(),
});
export type SlackAccessPayload = z.infer<typeof slackAccessPayloadSchema>;
