import { z } from "zod";

/** A human label for the token — e.g. the IdP it's pasted into ("Okta"). */
export const createScimTokenSchema = z.strictObject({
  label: z
    .string({ message: "Label is required" })
    .trim()
    .min(1, "Label is required")
    .max(64, "Keep the label under 64 characters"),
});
