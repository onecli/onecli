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
