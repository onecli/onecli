import { z } from "zod";

/**
 * Inviting someone to the organization.
 *
 * The role whitelist mirrors `ASSIGNABLE_MEMBER_ROLES` — `owner` is conferred
 * by creating the organization, never handed out. The email is lowercased here
 * so the invitation, the account that later registers with it, and the
 * membership row all agree on one spelling.
 */
export const createInvitationSchema = z.strictObject({
  email: z.email().trim().toLowerCase(),
  role: z.enum(["admin", "member"]),
});

/** Redeeming an invitation. The token is the whole credential. */
export const acceptInvitationSchema = z.strictObject({
  token: z.string().min(1),
});
