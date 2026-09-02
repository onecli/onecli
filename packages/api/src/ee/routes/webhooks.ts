import { Hono } from "hono";
import type { Context } from "hono";
import { db } from "@onecli/db";
import { logger } from "../../lib/logger";
import { RESEND_API_KEY } from "../../lib/env";
import { cloudOnly } from "../middleware/cloud-only";
import { notifyDiscord } from "../notifications/discord";
import { sendEmail, cancelScheduledEmails } from "../../services/email-service";
import {
  verifySvixSignature,
  webhookSecretsFrom,
} from "../../services/webhook-signature";

/**
 * Resend webhook intake (delivery status + inbound email) — hosted-platform
 * plumbing, dark on self-host by EDITION (a clean 404: the surface only exists
 * where our Resend account posts) and FAIL-CLOSED on configuration within
 * cloud: with no signing secret every request is rejected, never accepted
 * unverified. Configured, every request must carry a valid Resend (svix)
 * signature over the RAW body.
 *
 * ONE SECRET PER ENDPOINT — the provider issues a distinct signing secret for
 * each webhook URL, so the two routes read different variables:
 *   /resend  → RESEND_WEBHOOK_SECRET          (delivery-status endpoint)
 *   /inbound → RESEND_INBOUND_WEBHOOK_SECRET  (inbound-email endpoint)
 * Sharing one variable would leave whichever endpoint it does not belong to
 * refusing every delivery. Each accepts a whitespace/comma separated list so
 * a rotation (old + new valid together) needs no code change, and neither
 * endpoint's secret authenticates the other's traffic.
 *
 * One-click unsubscribe does NOT live here — it is free shared behavior
 * (routes/unsubscribe.ts): self-hosts that send email link to it.
 */
export const webhookRoutes = () => {
  const app = new Hono();

  // Resend intake is hosted-platform plumbing: our Resend account posts here.
  // Edition-dark on self-host with a clean 404 (the reviewer router's shape) —
  // the surface does not exist there at all, so a self-host never needs a
  // signing secret and never exposes the intake, whatever its env says. On
  // cloud the per-endpoint signature gates below decide.
  app.use("*", cloudOnly);

  // POST /resend — Resend delivery status webhooks
  app.post("/resend", async (c) => {
    const gate = await verifyResendRequest(c, "RESEND_WEBHOOK_SECRET");
    if ("refusal" in gate) return gate.refusal;
    try {
      const body = JSON.parse(gate.body) as Record<string, unknown>;

      const eventType = (body.type as string) ?? "unknown";
      const data = body.data as
        | { subject?: string; from?: string; to?: string[] }
        | undefined;

      await db.resendWebhook.create({
        data: {
          eventType,
          emailSubject: data?.subject ?? null,
          emailFrom: data?.from ?? null,
          emailTo: JSON.stringify(data?.to ?? []),
          eventData: data ? JSON.parse(JSON.stringify(data)) : undefined,
        },
      });

      // When an email is sent/delivered, clear stale synthetic
      // "email.scheduled" rows so cancelScheduledEmails won't try
      // to cancel an already-dispatched email.
      if (eventType === "email.sent" || eventType === "email.delivered") {
        const subject = data?.subject;
        const recipients = data?.to ?? [];
        if (subject) {
          for (const email of recipients) {
            await db.resendWebhook.updateMany({
              where: {
                eventType: "email.scheduled",
                emailSubject: subject,
                emailTo: { contains: email, mode: "insensitive" },
              },
              data: { eventType },
            });
          }
        }
      }

      // On complaint or hard bounce, mark the email as bad.
      // Soft (temporary) bounces should not permanently block sending.
      if (eventType === "email.complained") {
        const recipients = data?.to ?? [];
        for (const email of recipients) {
          await db.resendBadEmail.create({
            data: { email, eventType },
          });
        }
      } else if (eventType === "email.bounced") {
        const bounceType = (data as Record<string, unknown> | undefined)
          ?.bounce as { type?: string } | undefined;
        if (bounceType?.type === "hard") {
          const recipients = data?.to ?? [];
          for (const email of recipients) {
            await db.resendBadEmail.create({
              data: { email, eventType: "email.bounced.hard" },
            });
          }
        }
      }

      return c.json({ status: "OK" });
    } catch (err) {
      console.error("resend-webhooks error:", err);
      return c.json({ status: "OK" });
    }
  });

  // POST /inbound — Inbound email webhooks from Resend
  app.post("/inbound", async (c) => {
    const gate = await verifyResendRequest(c, "RESEND_INBOUND_WEBHOOK_SECRET");
    if ("refusal" in gate) return gate.refusal;
    try {
      const event = JSON.parse(gate.body) as InboundEmailEvent;

      if (event.type !== "email.received") {
        return c.json({ status: "OK" });
      }

      const { from, to, subject, email_id } = event.data;

      // Only process emails sent to reply.onecli.sh
      const isReplyDomain = to.some((addr) =>
        addr.endsWith("@reply.onecli.sh"),
      );
      if (!isReplyDomain) {
        return c.json({ status: "OK" });
      }

      const senderEmail = from.includes("<")
        ? (from.match(/<(.+)>/)?.[1] ?? from)
        : from;

      logger.warn({ from: senderEmail, subject, email_id }, "inbound reply");

      // 1. Fetch the full email body from Resend API
      let body: string | undefined;
      if (RESEND_API_KEY) {
        try {
          const res = await fetch(
            `https://api.resend.com/emails/receiving/${email_id}`,
            {
              headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
            },
          );
          if (res.ok) {
            const detail = (await res.json()) as { text?: string };
            body = detail.text ?? undefined;
          } else {
            logger.warn(
              { status: res.status, email_id },
              "resend API fetch failed",
            );
          }
        } catch (err) {
          logger.warn({ err, email_id }, "failed to fetch inbound email body");
        }
      }

      // Strip quoted reply for Discord — keep full body for email forward
      let replyOnly = body;
      if (replyOnly) {
        const lines = replyOnly.split("\n");
        const cutIndex = lines.findIndex(
          (line) =>
            /^On .+ wrote:$/.test(line.trim()) ||
            /^>/.test(line.trim()) ||
            /^-{3,}/.test(line.trim()) ||
            /^_{3,}/.test(line.trim()),
        );
        if (cutIndex > 0) {
          replyOnly = lines.slice(0, cutIndex).join("\n").trim();
        }
      }

      // 2. Cancel any scheduled follow-up emails for this user
      await cancelScheduledEmails(senderEmail).catch((err) => {
        logger.warn({ err, senderEmail }, "failed to cancel scheduled emails");
      });

      // 3. Auto-unsubscribe if the reply contains "unsubscribe"
      const wantsUnsubscribe = replyOnly
        ? /\bunsubscribe\b/i.test(replyOnly)
        : false;

      if (wantsUnsubscribe) {
        await db.resendBadEmail
          .create({
            data: { email: senderEmail, eventType: "email.unsubscribed" },
          })
          .catch(() => {});
        logger.info({ email: senderEmail }, "auto-unsubscribed via reply");
      }

      // 4. Notify Discord (stripped reply only)
      notifyDiscord("email_reply", {
        from: senderEmail,
        subject,
        body: replyOnly,
      });

      // 5. Forward to jonathan@onecli.sh (skip if they asked to unsubscribe)
      if (!wantsUnsubscribe) {
        await sendEmail({
          from: `OneCLI Reply <team@onecli.sh>`,
          replyTo: senderEmail,
          to: FORWARD_TO,
          subject: `Fwd: ${subject} (from ${senderEmail})`,
          text: [
            `Reply from: ${senderEmail}`,
            `Subject: ${subject}`,
            "",
            body ?? "(no body)",
          ].join("\n"),
          skipDuplicateCheck: true,
        }).catch((err) => {
          logger.warn({ err, from: senderEmail }, "failed to forward email");
        });
      }

      return c.json({ status: "OK" });
    } catch (err) {
      logger.error({ err }, "inbound email webhook error");
      return c.json({ status: "OK" });
    }
  });

  return app;
};

// ── Helpers ──────────────────────────────────────────────────────────

const FORWARD_TO = "jonathan@onecli.sh";

interface InboundEmailEvent {
  type: string;
  data: {
    email_id: string;
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    message_id: string;
  };
}

/**
 * The fail-closed intake gate. Refusals deliberately differ from the
 * handlers' always-200 posture: 500 (unconfigured) and 401 (bad signature)
 * make Resend retry / surface the misconfiguration, while handler-level
 * errors after an authentic request stay 200 so Resend never retries our
 * own bugs forever.
 */
const verifyResendRequest = async (
  c: Context,
  envVar: "RESEND_WEBHOOK_SECRET" | "RESEND_INBOUND_WEBHOOK_SECRET",
): Promise<{ body: string } | { refusal: Response }> => {
  // Call-time read (the unsubscribe-token pattern) so the fail-closed and
  // signed-accept arms are both testable without process-env baking.
  const secrets = webhookSecretsFrom(process.env[envVar]);
  if (secrets.length === 0) {
    logger.warn({ envVar }, "webhook signing secret not configured, rejecting");
    return { refusal: c.json({ error: "Webhook not configured" }, 500) };
  }
  const body = await c.req.text();
  const ok = verifySvixSignature({
    secrets,
    id: c.req.header("svix-id"),
    timestamp: c.req.header("svix-timestamp"),
    signature: c.req.header("svix-signature"),
    body,
  });
  if (!ok) {
    logger.warn({ envVar }, "resend webhook signature verification failed");
    return { refusal: c.json({ error: "Invalid signature" }, 401) };
  }
  return { body };
};
