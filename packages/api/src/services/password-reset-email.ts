import { sendEmail, isEmailConfigured } from "./email-service";
import { appOrigin } from "../lib/public-origins";

/**
 * The "forgot your password" email.
 *
 * Only ever sent to an address that already has an account — the identity
 * layer decides that, and deliberately answers the requester identically
 * either way so the form cannot be used to discover who has one.
 *
 * `url` is the reset link the identity layer minted; it carries the one-time
 * token and is rewritten to point at the dashboard, because the token is
 * redeemed by a page there rather than by the API that issued it.
 */
export const sendPasswordResetEmail = async (params: {
  recipientEmail: string;
  token: string;
}): Promise<void> => {
  if (!isEmailConfigured()) return;

  const resetUrl = `${appOrigin()}/auth/reset-password?token=${encodeURIComponent(
    params.token,
  )}`;

  await sendEmail({
    from: "OneCLI <team@onecli.sh>",
    replyTo: "team@onecli.sh",
    to: params.recipientEmail,
    subject: "Reset your OneCLI password",
    text: [
      "Someone asked to reset the password for this OneCLI account.",
      "",
      `Set a new password: ${resetUrl}`,
      "",
      "This link expires in an hour and can be used once.",
      "If you did not ask for this, you can ignore this email. Nothing has changed.",
      "",
      "OneCLI · onecli.sh",
    ].join("\n"),
    // A reset link is a credential in transit: never suppress it as a
    // duplicate, or a second genuine attempt would silently go nowhere.
    skipDuplicateCheck: true,
  });
};
