import { z } from "zod";

/**
 * find_recipient — the model-facing args. The bounds mirror the mention
 * layer's own clamps (80-char names, the scanner's normalization): a query
 * longer than a legal name cannot match one.
 */
export const findRecipientArgsSchema = z
  .object({
    query: z.string().trim().min(1).max(80),
    kind: z.enum(["person", "channel"]).optional(),
  })
  .strict();

/**
 * send_message — the model-facing args. `to` carries a person's exact name
 * or a #channel (the resolver decides); the text cap matches the send
 * service's own bound.
 */
export const sendMessageArgsSchema = z
  .object({
    to: z.string().trim().min(1).max(81),
    text: z.string().trim().min(1).max(4000),
  })
  .strict();

/**
 * message_agent — the model-facing args (PR 5b). `to` is another agent's
 * exact name (the roster in the instruction doc) or its agent id; the text
 * cap matches the agent link service's own bound.
 */
export const messageAgentArgsSchema = z
  .object({
    to: z.string().trim().min(1).max(80),
    text: z.string().trim().min(1).max(4000),
  })
  .strict();

/** `complete_task(report, peer?)`: the report for the person who opened the
 * task; `peer` names which task only when the agent owns several and the
 * call has no attributable origin. */
export const completeTaskArgsSchema = z
  .object({
    report: z.string().trim().min(1).max(4000),
    peer: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

/** read_conversation's bounds, shared by the args schema and the read
 * service: a window reaches back a year at most (older history is reached
 * by paging, which has no age limit), and one page is at most 200 messages
 * (Slack's recommended page size). */
export const READ_MAX_LOOKBACK_HOURS = 365 * 24;
export const READ_MAX_LIMIT = 200;

/**
 * read_conversation — the model-facing args. `conversation` is a name from
 * the agent's own read grants ("#weekly-reports", "@alex"); `thread` is a
 * message id from a previous read.
 */
const MESSAGE_ID = /^\d{1,12}\.\d{1,9}$/;
/** Not a message id = dropped, so a model slip widens nothing and fails nothing. */
const messageIdOrNothing = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v && MESSAGE_ID.test(v) ? v : undefined));

export const readConversationArgsSchema = z
  .object({
    // Omitted = "what may I read?" (the list, audience-fenced).
    conversation: z.string().trim().max(120).optional(),
    // Out-of-range windows clamp rather than fail.
    sinceHours: z
      .number()
      .int()
      .min(1)
      .optional()
      .transform((v) =>
        v === undefined ? v : Math.min(v, READ_MAX_LOOKBACK_HOURS),
      ),
    thread: messageIdOrNothing,
    // Page back through history: the `nextBefore` of the previous result.
    before: messageIdOrNothing,
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .transform((v) => (v === undefined ? v : Math.min(v, READ_MAX_LIMIT))),
  })
  .strict();
