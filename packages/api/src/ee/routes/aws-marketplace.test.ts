import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";

// The AWS Marketplace event intake: EventBridge license events delivered
// through the infra-owned SNS topic. These tests drive the real route with
// the service mocked: envelopes are signed with a locally generated RSA key
// whose certificate is served through a fetch mock, so the real SNS
// signature verification runs end-to-end. Covered: topic allowlisting,
// signature/cert gating, and dispatch of the two license event types.

// The router is edition-dark off cloud and `IS_CLOUD` freezes at module
// load, so pin cloud before the graph loads.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  delete process.env.EDITION;
  process.env.AWS_MARKETPLACE_PRODUCT_CODE = "testproductcode";
  process.env.AWS_MARKETPLACE_SNS_TOPIC_ARN =
    "arn:aws:sns:us-east-1:111111111111:onecli-test-aws-marketplace-events";
});

const state = vi.hoisted(() => ({
  syncCalls: [] as string[],
  deprovisionCalls: [] as Array<{
    customerAwsAccountId: string;
    licenseArn: string;
  }>,
}));

vi.mock("../billing/aws-marketplace/service", () => ({
  syncEntitlements: async (accountId: string) => {
    state.syncCalls.push(accountId);
    return { status: "subscribed", entitledAgents: 10 };
  },
  handleLicenseDeprovisioned: async (params: {
    customerAwsAccountId: string;
    licenseArn: string;
  }) => {
    state.deprovisionCalls.push(params);
    return { status: "unsubscribed", entitledAgents: 0 };
  },
}));

import { Hono } from "hono";
import { awsMarketplaceRoutes } from "./aws-marketplace";
import type { ApiEnv } from "../../types";

const TOPIC_ARN =
  "arn:aws:sns:us-east-1:111111111111:onecli-test-aws-marketplace-events";
// Unique per test file run: the route caches certs per URL, and a
// same-URL cert from a previous signature test would poison verification.
let certSerial = 0;

// ── Local SNS signer: RSA key + self-signed cert served via fetch mock ──

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });

const canonicalString = (
  msg: Record<string, string>,
  fields: readonly string[],
) => {
  let canonical = "";
  for (const field of fields) {
    if (msg[field] !== undefined) canonical += `${field}\n${msg[field]}\n`;
  }
  return canonical;
};

const NOTIFICATION_FIELDS = [
  "Message",
  "MessageId",
  "Subject",
  "Timestamp",
  "TopicArn",
  "Type",
] as const;

const sign = (key: KeyObject, canonical: string) => {
  const signer = createSign("RSA-SHA256");
  signer.update(canonical, "utf8");
  return signer.sign(key, "base64");
};

/** A validly-signed Notification envelope for the given EventBridge event. */
const signedEnvelope = (
  event: unknown,
  overrides: Record<string, string> = {},
) => {
  const base: Record<string, string> = {
    Type: "Notification",
    MessageId: `m-${++certSerial}`,
    TopicArn: TOPIC_ARN,
    Message: JSON.stringify(event),
    Timestamp: new Date().toISOString(),
    SignatureVersion: "2",
    SigningCertURL: `https://sns.us-east-1.amazonaws.com/cert-${certSerial}.pem`,
    ...overrides,
  };
  base.Signature = sign(privateKey, canonicalString(base, NOTIFICATION_FIELDS));
  return base;
};

const licenseEvent = (
  detailType: string,
  accountId = "123456789012",
  licenseArn = "arn:aws:license-manager::123456789012:license:l-1",
) => ({
  "detail-type": detailType,
  source: "aws.agreement-marketplace",
  detail: {
    acceptor: { accountId },
    product: { code: "testproductcode" },
    license: { arn: licenseArn },
    agreement: { id: "agmt-1" },
  },
});

const app = new Hono<ApiEnv>().route("/", awsMarketplaceRoutes());

const post = (body: unknown) =>
  app.request("/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

let fetchSpy: MockInstance;

beforeEach(() => {
  state.syncCalls.length = 0;
  state.deprovisionCalls.length = 0;
  // Serve our public key as the "SNS cert". Node's verifier accepts a
  // bare SPKI public key PEM wherever a certificate is expected.
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(publicKeyPem, { status: 200 }));
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("POST /events gating", () => {
  it("rejects invalid JSON", async () => {
    const res = await app.request("/events", {
      method: "POST",
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a message from a foreign topic before any parsing", async () => {
    const res = await post(
      signedEnvelope(licenseEvent("License Updated - Manufacturer"), {
        TopicArn: "arn:aws:sns:us-east-1:999999999999:attacker",
      }),
    );
    expect(res.status).toBe(403);
    expect(state.syncCalls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a tampered message (signature over different content)", async () => {
    const envelope = signedEnvelope(
      licenseEvent("License Updated - Manufacturer"),
    );
    envelope.Message = JSON.stringify(
      licenseEvent("License Updated - Manufacturer", "999999999999"),
    );
    const res = await post(envelope);
    expect(res.status).toBe(400);
    expect(state.syncCalls).toHaveLength(0);
  });

  it("rejects a signing cert from a non-SNS host", async () => {
    const res = await post(
      signedEnvelope(licenseEvent("License Updated - Manufacturer"), {
        SigningCertURL: "https://evil.example.com/cert.pem",
      }),
    );
    expect(res.status).toBe(400);
    expect(state.syncCalls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("POST /events dispatch", () => {
  it("License Updated triggers an entitlement sync for the buyer", async () => {
    const res = await post(
      signedEnvelope(licenseEvent("License Updated - Manufacturer")),
    );
    expect(res.status).toBe(200);
    expect(state.syncCalls).toEqual(["123456789012"]);
    expect(state.deprovisionCalls).toHaveLength(0);
  });

  it("License Deprovisioned routes through final-usage handling", async () => {
    const res = await post(
      signedEnvelope(licenseEvent("License Deprovisioned - Manufacturer")),
    );
    expect(res.status).toBe(200);
    expect(state.deprovisionCalls).toEqual([
      {
        customerAwsAccountId: "123456789012",
        licenseArn: "arn:aws:license-manager::123456789012:license:l-1",
      },
    ]);
    expect(state.syncCalls).toHaveLength(0);
  });

  it("an unknown detail-type is acknowledged without side effects", async () => {
    const res = await post(
      signedEnvelope(licenseEvent("Purchase Agreement Created - Proposer")),
    );
    expect(res.status).toBe(200);
    expect(state.syncCalls).toHaveLength(0);
    expect(state.deprovisionCalls).toHaveLength(0);
  });

  it("an event without an acceptor account is acknowledged and ignored", async () => {
    const res = await post(
      signedEnvelope({
        "detail-type": "License Updated - Manufacturer",
        detail: {},
      }),
    );
    expect(res.status).toBe(200);
    expect(state.syncCalls).toHaveLength(0);
  });
});
