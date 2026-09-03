// AWS Marketplace event intake (plans/aws-marketplace-listing.md §4),
// Concurrent Agreements standard: AWS Marketplace emits license lifecycle
// events to EventBridge (source `aws.agreement-marketplace`, us-east-1
// default bus). Our CDK subscribes an SNS topic to those rules and points
// an HTTPS subscription at this endpoint, so each POST carries an SNS
// envelope whose Message is the EventBridge event:
//   "License Updated - Manufacturer"       → re-sync entitlements
//   "License Deprovisioned - Manufacturer" → final overage metering within
//     the ~1h grace window, then re-sync (downgrade when no license left)
//
// Hosted-platform plumbing like the Stripe intake: cloudOnly (404 off
// cloud) and FAIL-CLOSED within cloud — with no product code configured
// the endpoint rejects, and only messages from the configured topic
// (AWS_MARKETPLACE_SNS_TOPIC_ARN) with a valid SNS signature are accepted.

import { Hono } from "hono";
import { createVerify } from "node:crypto";
import type { ApiEnv } from "../../types";
import { cloudOnly } from "../middleware/cloud-only";
import {
  handleLicenseDeprovisioned,
  syncEntitlements,
} from "../billing/aws-marketplace/service";
import {
  AWS_MARKETPLACE_SNS_TOPIC_ARN,
  isAwsMarketplaceConfigured,
} from "../billing/aws-marketplace/env";
import { logger } from "../../lib/logger";

/** The EventBridge event AWS Marketplace publishes for license lifecycle. */
interface MarketplaceLicenseEvent {
  "detail-type"?: string;
  source?: string;
  detail?: {
    acceptor?: { accountId?: string };
    product?: { code?: string };
    license?: { arn?: string };
    agreement?: { id?: string };
  };
}

export const awsMarketplaceRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", cloudOnly);

  // POST /events — SNS-delivered EventBridge license events. Unauthenticated
  // intake gated by SNS signature verification + topic allowlisting.
  app.post("/events", async (c) => {
    if (!isAwsMarketplaceConfigured()) {
      return c.json({ error: "Not configured" }, 404);
    }

    const raw = await c.req.text();
    let envelope: SnsEnvelope;
    try {
      envelope = JSON.parse(raw) as SnsEnvelope;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // Only our own topic: a valid signature from any OTHER topic (which
    // anyone with an AWS account can produce) is rejected before parsing.
    if (
      !AWS_MARKETPLACE_SNS_TOPIC_ARN ||
      envelope.TopicArn !== AWS_MARKETPLACE_SNS_TOPIC_ARN
    ) {
      logger.warn(
        { topicArn: envelope.TopicArn },
        "aws-marketplace: event from unexpected topic rejected",
      );
      return c.json({ error: "Unknown topic" }, 403);
    }

    const valid = await verifySnsSignature(envelope).catch((err) => {
      logger.warn({ err }, "aws-marketplace: SNS signature verification error");
      return false;
    });
    if (!valid) {
      return c.json({ error: "Invalid signature" }, 400);
    }

    if (envelope.Type === "SubscriptionConfirmation" && envelope.SubscribeURL) {
      // Confirm by fetching the AWS-provided URL (host validated in verify).
      await fetch(envelope.SubscribeURL);
      logger.info("aws-marketplace: SNS subscription confirmed");
      return c.json({ ok: true });
    }

    if (envelope.Type === "Notification" && envelope.Message) {
      let event: MarketplaceLicenseEvent;
      try {
        event = JSON.parse(envelope.Message) as MarketplaceLicenseEvent;
      } catch {
        return c.json({ error: "Invalid message payload" }, 400);
      }

      const detailType = event["detail-type"];
      const accountId = event.detail?.acceptor?.accountId;
      const licenseArn = event.detail?.license?.arn;

      logger.info(
        { detailType, accountId, licenseArn },
        "aws-marketplace: license event",
      );

      if (!accountId) return c.json({ ok: true });

      // The event is only a trigger — entitlement truth is always re-pulled
      // from GetEntitlements, so a forged/malformed detail can at worst
      // cause an extra sync.
      switch (detailType) {
        case "License Updated - Manufacturer":
          await syncEntitlements(accountId);
          break;
        case "License Deprovisioned - Manufacturer":
          if (licenseArn) {
            await handleLicenseDeprovisioned({
              customerAwsAccountId: accountId,
              licenseArn,
            });
          } else {
            await syncEntitlements(accountId);
          }
          break;
        default:
          break;
      }
      return c.json({ ok: true });
    }

    return c.json({ ok: true });
  });

  return app;
};

// ── SNS signature verification ─────────────────────────────────────────────

interface SnsEnvelope {
  Type?: string;
  MessageId?: string;
  TopicArn?: string;
  Message?: string;
  Timestamp?: string;
  Token?: string;
  SubscribeURL?: string;
  Subject?: string;
  SignatureVersion?: string;
  Signature?: string;
  SigningCertURL?: string;
}

const SNS_CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

/**
 * Standard SNS signature verification: the signing cert must come from an
 * https amazonaws.com SNS host, and the SHA1/SHA256 signature must verify
 * over the canonical string for the message type.
 */
async function verifySnsSignature(msg: SnsEnvelope): Promise<boolean> {
  if (!msg.Signature || !msg.SigningCertURL || !msg.Type) return false;

  const certUrl = new URL(msg.SigningCertURL);
  if (certUrl.protocol !== "https:" || !SNS_CERT_HOST.test(certUrl.hostname)) {
    return false;
  }
  if (msg.SubscribeURL) {
    const subUrl = new URL(msg.SubscribeURL);
    if (subUrl.protocol !== "https:" || !SNS_CERT_HOST.test(subUrl.hostname)) {
      return false;
    }
  }

  const cert = await getSnsCert(msg.SigningCertURL);

  const fields =
    msg.Type === "Notification"
      ? ([
          "Message",
          "MessageId",
          "Subject",
          "Timestamp",
          "TopicArn",
          "Type",
        ] as const)
      : ([
          "Message",
          "MessageId",
          "SubscribeURL",
          "Timestamp",
          "Token",
          "TopicArn",
          "Type",
        ] as const);

  let canonical = "";
  for (const field of fields) {
    const value = msg[field];
    if (value !== undefined) canonical += `${field}\n${value}\n`;
  }

  const algorithm = msg.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
  const verifier = createVerify(algorithm);
  verifier.update(canonical, "utf8");
  return verifier.verify(cert, msg.Signature, "base64");
}

const certCache = new Map<string, string>();

async function getSnsCert(url: string): Promise<string> {
  const cached = certCache.get(url);
  if (cached) return cached;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SNS cert fetch failed: ${res.status}`);
  const pem = await res.text();
  certCache.set(url, pem);
  return pem;
}
