import { DISCORD_WEBHOOK_URL, ENVIRONMENT, IS_CLOUD } from "../../lib/env";
import { logger } from "../../lib/logger";

const WEBHOOK_URL = DISCORD_WEBHOOK_URL;
const REVIEW_WEBHOOK_URL = process.env.DISCORD_REVIEW_WEBHOOK_URL ?? "";

const ENV_LABEL = ENVIRONMENT;
const ENV_COLOR = ENV_LABEL === "prod" ? 0xfbbf24 : 0x9ca3af;

const countryCodeToFlag = (code: string) =>
  code
    .toUpperCase()
    .replace(/./g, (c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65));

type EventType =
  | "user_signup"
  | "email_reply"
  | "onboarding_completed"
  | "app_request"
  | "reviewer_login"
  | "payment"
  | "subscription_cancellation_scheduled"
  | "subscription_churned"
  | "payment_collected";

const REVIEW_EVENTS = new Set<EventType>([
  "reviewer_login",
  "payment",
  "subscription_cancellation_scheduled",
  "subscription_churned",
  "payment_collected",
]);

type EventPayload = {
  user_signup: {
    email: string;
    name?: string | null;
    countryCode?: string;
    country?: string;
    source?: string;
  };
  email_reply: {
    from: string;
    subject: string;
    body?: string;
  };
  onboarding_completed: {
    email: string;
    agentName?: string | null;
  };
  app_request: {
    email: string;
    name?: string | null;
    appName: string;
    appWebsite?: string | null;
  };
  reviewer_login: {
    email: string;
    countryCode?: string;
    country?: string;
  };
  payment: {
    email: string;
    organizationId?: string | null;
    organizationName?: string | null;
    plan: string;
    type: "new_subscription" | "plan_switch";
    countryCode?: string;
    country?: string;
  };
  subscription_cancellation_scheduled: {
    email: string;
    organizationId?: string | null;
    organizationName?: string | null;
    plan: string;
    startedAt: number;
    churnsAt: number;
    countryCode?: string;
  };
  subscription_churned: {
    email: string;
    organizationId?: string | null;
    organizationName?: string | null;
    plan: string;
    countryCode?: string;
    everPaid?: boolean;
  };
  payment_collected: {
    organizationName: string;
    plan: string;
    amountPaid: string;
    invoiceUrl: string | null;
    countryCode?: string;
    country?: string;
  };
};

const formatEmbed = <T extends EventType>(event: T, data: EventPayload[T]) => {
  switch (event) {
    case "user_signup": {
      const { email, name, countryCode, country, source } =
        data as EventPayload["user_signup"];
      const lines: string[] = [];
      if (name) lines.push(`**${name}** just signed up`);
      lines.push(`email: ${email}`);
      if (source) lines.push(`**Via:** ${source}`);
      if (countryCode) {
        lines.push(
          `${countryCodeToFlag(countryCode)} ${country ?? countryCode}`,
        );
      }
      return {
        title: `New Signup [${ENV_LABEL}]`,
        description: lines.join("\n"),
        color: ENV_COLOR,
        timestamp: new Date().toISOString(),
      };
    }
    case "email_reply": {
      const { from, subject, body } = data as EventPayload["email_reply"];
      const lines: string[] = [];
      lines.push(`**From:** ${from}`);
      lines.push(`**Subject:** ${subject}`);
      if (body) {
        const trimmed = body.length > 500 ? body.slice(0, 500) + "..." : body;
        lines.push(`\n${trimmed}`);
      }
      return {
        title: `Email Reply [${ENV_LABEL}]`,
        description: lines.join("\n"),
        color: 0x22c55e,
        timestamp: new Date().toISOString(),
      };
    }
    case "app_request": {
      const { email, name, appName, appWebsite } =
        data as EventPayload["app_request"];
      const lines: string[] = [`**App request:** ${appName}`];
      if (appWebsite) lines.push(`**Website:** ${appWebsite}`);
      lines.push(`**From:** ${email}${name ? ` (${name})` : ""}`);
      return {
        title: `App Request [${ENV_LABEL}]`,
        description: lines.join("\n"),
        color: 0x3b82f6,
        timestamp: new Date().toISOString(),
      };
    }
    case "onboarding_completed": {
      const { email, agentName } = data as EventPayload["onboarding_completed"];
      const lines: string[] = [`**${email}** completed onboarding`];
      // The hosted agent created during the flow — absent on the skip path.
      if (agentName) lines.push(`**Agent:** ${agentName}`);
      return {
        title: `Onboarding Completed [${ENV_LABEL}]`,
        description: lines.join("\n"),
        color: 0x22c55e,
        timestamp: new Date().toISOString(),
      };
    }
    case "reviewer_login": {
      const { email, countryCode, country } =
        data as EventPayload["reviewer_login"];
      const lines = [`**${email}** signed in via reviewer login`];
      if (countryCode) {
        lines.push(
          `${countryCodeToFlag(countryCode)} ${country ?? countryCode}`,
        );
      }
      return {
        title: `Reviewer Login [${ENV_LABEL}]`,
        description: lines.join("\n"),
        color: 0xa855f7,
        timestamp: new Date().toISOString(),
      };
    }
    case "payment": {
      const {
        email,
        organizationId,
        organizationName,
        plan,
        type,
        countryCode,
        country,
      } = data as EventPayload["payment"];
      const lines: string[] = [];
      const label =
        type === "new_subscription" ? "New subscription" : "Plan switch";
      lines.push(`**${label}** to **${plan}** 💰`);
      lines.push(`**Email:** ${email}`);
      if (organizationName) {
        const orgLine = organizationId
          ? `**Org:** ${organizationName} (${organizationId})`
          : `**Org:** ${organizationName}`;
        lines.push(orgLine);
      }
      if (countryCode) {
        lines.push(
          `${countryCodeToFlag(countryCode)} ${country ?? countryCode}`,
        );
      }
      return {
        title: `Payment [${ENV_LABEL}]`,
        description: lines.join("\n"),
        color: 0x22c55e,
        timestamp: new Date().toISOString(),
      };
    }
    case "subscription_cancellation_scheduled": {
      const {
        email,
        organizationId,
        organizationName,
        plan,
        startedAt,
        churnsAt,
        countryCode,
      } = data as EventPayload["subscription_cancellation_scheduled"];
      const lines: string[] = [];
      lines.push(`**${email}** scheduled cancellation ⚠️`);
      if (organizationName) {
        const orgLine = organizationId
          ? `**Org:** ${organizationName} (${organizationId})`
          : `**Org:** ${organizationName}`;
        lines.push(orgLine);
      }
      lines.push(`**Plan:** ${plan}`);
      lines.push(`**Started:** <t:${startedAt}:D>`);
      lines.push(`**Churns:** <t:${churnsAt}:D>`);
      if (countryCode) {
        lines.push(`${countryCodeToFlag(countryCode)} ${countryCode}`);
      }
      return {
        title: `Cancellation Scheduled [${ENV_LABEL}]`,
        description: lines.join("\n"),
        color: 0xf97316,
        timestamp: new Date().toISOString(),
      };
    }
    case "subscription_churned": {
      const {
        email,
        organizationId,
        organizationName,
        plan,
        countryCode,
        everPaid,
      } = data as EventPayload["subscription_churned"];
      const paidLabel = everPaid === false ? " (trial only)" : "";
      const lines: string[] = [];
      lines.push(`**${email || "unknown"}** has churned${paidLabel} 🚨`);
      if (organizationName) {
        const orgLine = organizationId
          ? `**Org:** ${organizationName} (${organizationId})`
          : `**Org:** ${organizationName}`;
        lines.push(orgLine);
      }
      lines.push(`**Plan:** ${plan}`);
      if (countryCode) {
        lines.push(`${countryCodeToFlag(countryCode)} ${countryCode}`);
      }
      return {
        title: `Subscription Churned [${ENV_LABEL}]`,
        description: lines.join("\n"),
        color: everPaid === false ? 0x9ca3af : 0xef4444,
        timestamp: new Date().toISOString(),
      };
    }
    case "payment_collected": {
      const d = data as EventPayload["payment_collected"];
      const lines: string[] = [];
      lines.push(`**${d.organizationName}** (${d.plan})`);
      if (d.countryCode) {
        lines.push(
          `${countryCodeToFlag(d.countryCode)} ${d.country ?? d.countryCode}`,
        );
      }
      lines.push(`**Amount: $${d.amountPaid}**`);
      if (d.invoiceUrl) lines.push(`\n[View Invoice](${d.invoiceUrl})`);
      return {
        title: `Payment Collected [${ENV_LABEL}]`,
        description: lines.join("\n"),
        color: 0x22c55e,
        timestamp: new Date().toISOString(),
      };
    }
    default:
      return { title: event, description: JSON.stringify(data) };
  }
};

export const notifyDiscord = <T extends EventType>(
  event: T,
  data: EventPayload[T],
) => {
  // Operator notifications into OUR Discord — a hosted-platform surface, not
  // product behavior. Edition-dark at the one choke point every caller shares,
  // so a self-host that happens to inherit a DISCORD_WEBHOOK_URL (a copied
  // env file, an ambient shell) never posts to it. Silent by design: there is
  // nothing for a self-hoster to act on, and a warn per event would be noise.
  if (!IS_CLOUD) return;

  const url = (REVIEW_EVENTS.has(event) && REVIEW_WEBHOOK_URL) || WEBHOOK_URL;
  if (!url) {
    logger.warn(
      { event },
      "DISCORD_WEBHOOK_URL not configured, skipping notification",
    );
    return;
  }

  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [formatEmbed(event, data)] }),
  }).catch((err) => {
    logger.warn({ err, event }, "discord notification failed");
  });
};
