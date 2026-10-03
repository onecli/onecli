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
