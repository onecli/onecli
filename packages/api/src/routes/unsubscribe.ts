import { Hono } from "hono";
import { db } from "@onecli/db";
import { logger } from "../lib/logger";
import { cancelScheduledEmails } from "../services/email-service";
import { verifyUnsubscribeToken } from "../services/unsubscribe-token";

/**
 * One-click unsubscribe (RFC 8058) — SHARED, not EE: any deployment that
 * sets RESEND_API_KEY sends invitation/password-reset email whose headers
 * and footers link here, self-hosts included.
 *
 * Token-only by design: the email is accepted exclusively from the signed
 * unsubscribe token minted by the sender. A bare `?email=` parameter is
 * NOT honored — that would let anyone unsubscribe any address.
 */
export const unsubscribeRoutes = () => {
  const app = new Hono();

  // POST / — the RFC 8058 one-click endpoint email clients call, and the
  // target of the confirm button below.
  app.post("/", async (c) => {
    const email = resolveEmail(c.req.raw);
    if (email) {
      await markUnsubscribed(email).catch(() => {});
    }
    // A human who pressed the button gets a page; mail clients get the JSON
    // they expect (any 2xx satisfies one-click).
    if (c.req.header("accept")?.includes("text/html")) {
      const heading = email ? "You've been unsubscribed" : "Invalid link";
      const message = email
        ? "You won't receive any more emails from OneCLI. If this was a mistake, reach out to team@onecli.sh."
        : "This unsubscribe link is invalid or has expired. Contact team@onecli.sh if you need help.";
      return new Response(
        `<!DOCTYPE html>
<html><head><title>Unsubscribe - OneCLI</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 440px; margin: 80px auto; text-align: center; color: #111827;">
  <h2 style="font-size: 20px; font-weight: 600;">${heading}</h2>
  <p style="font-size: 15px; line-height: 1.6; color: #4b5563;">${message}</p>
</body></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    }
    return c.json({ status: "OK" });
  });

  // GET / — the browser fallback. CONFIRMS, never mutates: the token URL
  // travels in every email's List-Unsubscribe header, and mail-security
  // gateways fetch such links on delivery. A mutating GET would let one
  // prefetch (or one forwarded email) permanently suppress every message to
  // that address, transactional mail included. RFC 8058's one-click IS the
  // POST below; a human clicks the button.
  app.get("/", (c) => {
    const email = resolveEmail(c.req.raw);
    const body = email
      ? `<h2 style="font-size: 20px; font-weight: 600;">Unsubscribe ${escapeHtml(email)}?</h2>
  <p style="font-size: 15px; line-height: 1.6; color: #4b5563;">You will stop receiving emails from OneCLI.</p>
  <form method="POST" action="${escapeHtml(c.req.url)}">
    <button type="submit" style="font: inherit; font-size: 15px; padding: 10px 18px; border-radius: 8px; border: 0; background: #111827; color: #fff; cursor: pointer;">Unsubscribe</button>
  </form>`
      : `<h2 style="font-size: 20px; font-weight: 600;">Invalid link</h2>
  <p style="font-size: 15px; line-height: 1.6; color: #4b5563;">This unsubscribe link is invalid or has expired. Contact team@onecli.sh if you need help.</p>`;

    return new Response(
      `<!DOCTYPE html>
<html><head><title>Unsubscribe - OneCLI</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 440px; margin: 80px auto; text-align: center; color: #111827;">
  ${body}
</body></html>`,
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  });

  return app;
};

const resolveEmail = (request: Request): string | null => {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return null;
  return verifyUnsubscribeToken(token);
};

/** The email and the echoed URL land in HTML — escape both. */
const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const markUnsubscribed = async (email: string) => {
  const exists = await db.resendBadEmail.findFirst({
    where: { email, eventType: "unsubscribed" },
    select: { id: true },
  });
  if (!exists) {
    await db.resendBadEmail.create({
      data: { email, eventType: "unsubscribed" },
    });
    logger.info({ email }, "user unsubscribed");
  }

  await cancelScheduledEmails(email).catch((err) => {
    logger.warn(
      { err, email },
      "failed to cancel scheduled emails on unsubscribe",
    );
  });
};
