import { db } from "@onecli/db";
import { RESEND_API_KEY } from "../lib/env";
import { logger } from "../lib/logger";
import { createUnsubscribeToken } from "./unsubscribe-token";

import { getSelfUrl } from "../providers";

/**
 * Whether this deployment can send email at all.
 *
 * Read the configuration directly rather than inferring it from `sendEmail`'s
 * return: that is `null` for four different reasons — no key, a blocked
 * recipient, a suppressed duplicate, and a Resend error — so it cannot tell
 * "this deployment does not do email" apart from "that one message did not go".
 *
 * Callers use this to stop promising a delivery that was never attempted, and
 * to hide affordances (a password-reset link) that would go nowhere.
 */
export const isEmailConfigured = (): boolean => Boolean(RESEND_API_KEY.trim());

interface SendEmailOptions {
  from: string;
  replyTo: string;
  to: string;
  /** Optional CC recipient(s). Not subject to the blocked/duplicate checks. */
  cc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  /** ISO-8601 datetime — Resend will hold the email until then (max 72h). */
  scheduledAt?: string;
  /** Skip the duplicate check (e.g. for forwarding replies that may repeat). */
  skipDuplicateCheck?: boolean;
}

/**
 * Send an email via Resend with bad-email and duplicate checks.
 *
 * 1. Checks `resend_bad_emails` — skips bounced/complained addresses.
 * 2. Checks `resend_webhooks` — prevents duplicate sends for the same
 *    recipient + subject combo.
 * 3. Sends via Resend API.
 * 4. Logs a synthetic "email.sent" row into `resend_webhooks` so future
 *    duplicate checks and the webhook table stay consistent.
 *
 * Returns the Resend message ID on success, or null if skipped/failed.
 */
export const sendEmail = async (
  opts: SendEmailOptions,
): Promise<string | null> => {
  if (!RESEND_API_KEY) {
    logger.warn("RESEND_API_KEY not set, skipping email");
    return null;
  }

  const {
    from,
    replyTo,
    to,
    cc,
    subject,
    text,
    html,
    scheduledAt,
    skipDuplicateCheck,
  } = opts;

  // 1. Skip bad emails (bounced / complained)
  const bad = await db.resendBadEmail.findFirst({
    where: { email: to },
    select: { id: true },
  });
  if (bad) {
    logger.info({ email: to, subject }, "skipping email — bad email");
    return null;
  }

  // 2. Duplicate check — same recipient + subject already sent
  if (!skipDuplicateCheck) {
    const duplicate = await db.resendWebhook.findFirst({
      where: {
        emailTo: { contains: to },
        emailSubject: subject,
      },
      select: { id: true },
    });
    if (duplicate) {
      logger.info({ email: to, subject }, "skipping email — already sent");
      return null;
    }
  }

  // 3. Send via Resend. Unsubscribe headers only when a token can be
  // minted — with no UNSUBSCRIBE_TOKEN_SECRET the URL would be forgeable,
  // so the mail goes out without the one-click headers instead.
  const unsubscribeUrl = buildUnsubscribeUrl(to);
  const payload: Record<string, unknown> = {
    from,
    to: [to],
    reply_to: replyTo,
    subject,
    ...(unsubscribeUrl && {
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  };
  if (cc) payload.cc = Array.isArray(cc) ? cc : [cc];
  if (text) payload.text = text;
  if (html) payload.html = html;
  if (scheduledAt) payload.scheduled_at = scheduledAt;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errBody = await res.text();
    logger.error(
      { status: res.status, body: errBody, email: to, subject },
      "email send failed",
    );
    return null;
  }

  const data = (await res.json()) as { id?: string };
  const resendId = data.id ?? null;

  // 4. Log synthetic row
  if (resendId) {
    const eventType = scheduledAt ? "email.scheduled" : "email.sent";
    await db.resendWebhook.create({
      data: {
        eventType,
        emailSubject: subject,
        emailFrom: from,
        emailTo: JSON.stringify([to]),
        eventData: {
          syntheticEvent: true,
          resendId,
          ...(scheduledAt && { scheduledAt }),
        },
      },
    });
    logger.info({ email: to, subject, resendId, eventType }, "email queued");
  }

  return resendId;
};

export const buildUnsubscribeUrl = (email: string): string | null => {
  const token = createUnsubscribeToken(email);
  if (!token) return null;
  return `${getSelfUrl()}/v1/webhooks/unsubscribe?token=${token}`;
};

/**
 * Cancel any scheduled (not yet sent) emails for a recipient.
 * Looks up "email.scheduled" rows in resend_webhooks, extracts the
 * Resend ID, and calls the Resend cancel API.
 */
export const cancelScheduledEmails = async (
  recipientEmail: string,
): Promise<void> => {
  if (!RESEND_API_KEY) return;

  const scheduled = await db.resendWebhook.findMany({
    where: {
      eventType: "email.scheduled",
      emailTo: { contains: recipientEmail, mode: "insensitive" },
    },
    select: { id: true, eventData: true, emailSubject: true },
  });

  if (scheduled.length === 0) {
    logger.info(
      { email: recipientEmail },
      "no scheduled emails found to cancel",
    );
    return;
  }

  logger.info(
    { email: recipientEmail, count: scheduled.length },
    "cancelling scheduled emails",
  );

  for (const row of scheduled) {
    const data = row.eventData as { resendId?: string } | null;
    const resendId = data?.resendId;
    if (!resendId) continue;

    try {
      const res = await fetch(
        `https://api.resend.com/emails/${resendId}/cancel`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
        },
      );

      if (res.ok) {
        // Mark as cancelled so it won't be picked up again
        await db.resendWebhook.update({
          where: { id: row.id },
          data: { eventType: "email.cancelled" },
        });
        logger.info(
          { resendId, email: recipientEmail, subject: row.emailSubject },
          "scheduled email cancelled",
        );
      } else {
        const errBody = await res.text();
        logger.warn(
          {
            resendId,
            email: recipientEmail,
            subject: row.emailSubject,
            status: res.status,
            body: errBody,
          },
          "resend cancel API failed",
        );
      }
    } catch (err) {
      logger.warn({ err, resendId }, "failed to cancel scheduled email");
    }
  }
};
