import { z } from "zod";

/**
 * Registered SSH public keys (the account-level identity half of the SSH
 * front door). The publicKey bound matches the mint schema's: an ed25519
 * line is ~110 chars, so 1024 is generous while bounding hostile input.
 */

export const MAX_SSH_KEY_NAME_LENGTH = 100;

/**
 * Per-user registry cap — a code constant, not an env knob: it exists to
 * bound abuse (rows are inert public material), not to be tuned per deploy.
 */
export const MAX_SSH_KEYS_PER_USER = 25;

export const createSshKeySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(
      MAX_SSH_KEY_NAME_LENGTH,
      `Name must be at most ${MAX_SSH_KEY_NAME_LENGTH} characters`,
    ),
  publicKey: z.string().trim().min(1, "Public key is required").max(1024),
});

export type CreateSshKeyInput = z.infer<typeof createSshKeySchema>;
