import { sendEmail, isEmailConfigured } from "./email-service";
import { appOrigin } from "../lib/public-origins";

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * The link an invited person follows.
 *
 * Only the token travels: the organization's name and slug are resolved from
 * it server-side. They used to ride the query string, which meant anyone could
 * craft a /join URL that displayed any organization name they liked.
 */
export const buildInviteUrl = (token: string): string =>
  `${appOrigin()}/join?token=${encodeURIComponent(token)}`;

const buildHtml = (raw: {
  orgName: string;
  ownerEmail: string;
  acceptUrl: string;
}): string => {
  const params = {
    orgName: escapeHtml(raw.orgName),
    ownerEmail: escapeHtml(raw.ownerEmail),
    acceptUrl: escapeHtml(raw.acceptUrl),
  };
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0; padding:0; background-color:#f9fafb; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb; padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px; background-color:#ffffff; border-radius:8px; border:1px solid #e5e7eb;">
          <tr>
            <td style="padding:40px 40px 0;">
              <img src="https://app.onecli.sh/onecli-full-logo.png" alt="OneCLI" width="120" style="display:block; margin:0 auto 32px;" />
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px;">
              <h1 style="margin:0 0 16px; font-size:22px; font-weight:600; color:#111827; text-align:center;">
                You have been invited to join ${params.orgName}.
              </h1>
              <p style="margin:0 0 24px; font-size:15px; line-height:1.6; color:#4b5563; text-align:center;">
                ${params.orgName} is an organization owned by
                <a href="mailto:${params.ownerEmail}" style="color:#14994c; text-decoration:none;">${params.ownerEmail}</a>.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 40px 32px;">
              <a href="${params.acceptUrl}" style="display:inline-block; background-color:#14994c; color:#ffffff; font-size:15px; font-weight:600; text-decoration:none; padding:12px 28px; border-radius:6px;">
                Join this organization
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px 32px; border-top:1px solid #e5e7eb; padding-top:24px;">
              <p style="margin:0 0 8px; font-size:14px; font-weight:600; color:#111827;">
                What happens when I join an organization?
              </p>
              <p style="margin:0; font-size:14px; line-height:1.6; color:#6b7280;">
                You'll get your own workspace within the organization and collaborate with your team under a shared plan.
                If you do not recognize this organization, please contact us at
                <a href="mailto:team@onecli.sh" style="color:#14994c; text-decoration:none;">team@onecli.sh</a>.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 40px; border-top:1px solid #e5e7eb;">
              <p style="margin:0; font-size:12px; color:#9ca3af; text-align:center;">
                OneCLI &middot; onecli.sh
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

const buildText = (params: {
  orgName: string;
  ownerEmail: string;
  acceptUrl: string;
}): string =>
  [
    `You have been invited to join ${params.orgName}.`,
    "",
    `${params.orgName} is an organization owned by ${params.ownerEmail}.`,
    "",
    `Join this organization: ${params.acceptUrl}`,
    "",
    "What happens when I join an organization?",
    "You'll get your own workspace within the organization and collaborate with your team under a shared plan.",
    "If you do not recognize this organization, please contact us at team@onecli.sh.",
    "",
    "OneCLI · onecli.sh",
  ].join("\n");

/**
 * Email the invitation, if this deployment can send email.
 *
 * Returns whether anything was actually sent, so the caller can tell the
 * inviter the truth instead of always claiming delivery — the copyable link is
 * the path that always works.
 */
export const sendInvitationEmail = async (params: {
  recipientEmail: string;
  inviterEmail: string;
  organizationName: string;
  ownerEmail: string;
  token: string;
}): Promise<boolean> => {
  if (!isEmailConfigured()) return false;

  const acceptUrl = buildInviteUrl(params.token);

  await sendEmail({
    from: "OneCLI <team@onecli.sh>",
    replyTo: "team@onecli.sh",
    to: params.recipientEmail,
    subject: `${params.inviterEmail} has invited you to join ${params.organizationName}`,
    html: buildHtml({
      orgName: params.organizationName,
      ownerEmail: params.ownerEmail,
      acceptUrl,
    }),
    text: buildText({
      orgName: params.organizationName,
      ownerEmail: params.ownerEmail,
      acceptUrl,
    }),
    skipDuplicateCheck: true,
  });

  return true;
};
