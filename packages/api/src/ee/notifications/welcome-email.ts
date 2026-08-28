import { sendEmail } from "../../services/email-service";
import { logger } from "../../lib/logger";

const FROM = "Jonathan from OneCLI <jonathan@onecli.sh>";
const REPLY_TO = "jonathan@reply.onecli.sh";

const QUICKSTART_URL = "https://onecli.sh/docs/quickstart";
const DISCORD_URL = "https://discord.gg/PSztzsQB3g";

const welcomeBody = (name: string | null | undefined) => {
  const greeting = name ? `Hi ${name}` : "Hi";
  return `${greeting},

Thanks for signing up for OneCLI! I'm Jonathan, one of the founders - here to help.

Now that your account is set up, follow our quickstart guide to connect your first agent: ${QUICKSTART_URL}

A few quick things:

- If you run into any issues or want guidance on your setup, reply right here. I read and respond to every message.
- If something feels confusing or missing, tell me. Your feedback shapes the product.
- Join our community Discord for support, discussions, and more: ${DISCORD_URL}

P.S. I'm curious. What brought you to OneCLI? How did you hear about us?

Jonathan
Founder, OneCLI`;
};

const followUpBody = (name: string | null | undefined) => {
  const greeting = name ? `Hey ${name}` : "Hey";
  return `${greeting},

Did you get a chance to connect your first agent? I'd love to hear what you're working on.

If you're setting things up for a team, reply and I'll walk you through the best way to structure it. Most teams are up and running in about 10 minutes.

Jonathan
Founder, OneCLI`;
};

const directAskBody = (name: string | null | undefined) => {
  const greeting = name ? `Hey ${name}` : "Hey";
  return `${greeting},

One thing I keep hearing from teams: once agents run on their own (CI, cron, background jobs), the key management gets scary fast.

That's why OneCLI never gives agents your secrets. Credentials are injected at the gateway, so the agent gets access without holding any keys. If it gets compromised, there's nothing to leak.

Are you running any agents autonomously yet? I'm curious what your setup looks like.

Jonathan
Founder, OneCLI`;
};

const FOLLOW_UP_1_DELAY_MS = 48 * 60 * 60 * 1000;
const FOLLOW_UP_2_DELAY_MS = 71 * 60 * 60 * 1000;

export const sendWelcomeEmail = (
  email: string,
  name: string | null | undefined,
) => {
  sendEmail({
    from: FROM,
    replyTo: REPLY_TO,
    to: email,
    subject: "Welcome to OneCLI",
    text: welcomeBody(name),
  }).catch((err) => {
    logger.warn({ err, email }, "welcome email failed");
  });

  const scheduledAt1 = new Date(
    Date.now() + FOLLOW_UP_1_DELAY_MS,
  ).toISOString();
  sendEmail({
    from: FROM,
    replyTo: REPLY_TO,
    to: email,
    subject: "how's the setup going?",
    text: followUpBody(name),
    scheduledAt: scheduledAt1,
  }).catch((err) => {
    logger.warn({ err, email }, "follow-up email 1 failed");
  });

  const scheduledAt2 = new Date(
    Date.now() + FOLLOW_UP_2_DELAY_MS,
  ).toISOString();
  sendEmail({
    from: FROM,
    replyTo: REPLY_TO,
    to: email,
    subject: "how are you handling agent keys?",
    text: directAskBody(name),
    scheduledAt: scheduledAt2,
  }).catch((err) => {
    logger.warn({ err, email }, "follow-up email 2 failed");
  });
};
