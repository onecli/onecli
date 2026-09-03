import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { generateKeyPairSync, createSign } from "node:crypto";

// Integration-boundary lock for the AWS Marketplace event intake: infra
// (packages/infra/lib/api-server-stack.ts) subscribes the SNS relay topic to
//   https://<apiDomain>/v1/billing/aws-marketplace/events
// so this test drives the REAL app (createApiApp — basePath, error handler,
// the full middleware chain, registerEeRoutes) at that exact path, not a
// bare router. If the mount ever moves, this fails before prod finds out
// via silently-dropped license events.

// The router is edition-dark off cloud and IS_CLOUD freezes at module load,
// so pin cloud (+ the marketplace config) before the graph loads.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  delete process.env.EDITION;
  process.env.SECRET_ENCRYPTION_KEY ??= "test-secret";
  process.env.OAUTH_STATE_SECRET ??= "test-secret";
  process.env.AWS_MARKETPLACE_PRODUCT_CODE = "testproductcode";
  process.env.AWS_MARKETPLACE_SNS_TOPIC_ARN =
    "arn:aws:sns:us-east-1:111111111111:onecli-test-aws-marketplace-events";
});

const state = vi.hoisted(() => ({
  syncCalls: [] as string[],
}));

vi.mock("../billing/aws-marketplace/service", () => ({
  syncEntitlements: async (accountId: string) => {
    state.syncCalls.push(accountId);
    return { status: "subscribed", entitledAgents: 10 };
  },
  handleLicenseDeprovisioned: async () => null,
}));

// The real app touches the DB through many middlewares; none should fire on
// this unauthenticated intake, but mock defensively like ee-mount-lock does.
vi.mock("@onecli/db", () => {
  const model = () => new Proxy({}, { get: () => async () => null });
  return {
    Prisma: {},
    db: new Proxy({}, { get: () => model() }),
  };
});

import { createApiApp } from "../../app";

const TOPIC_ARN =
  "arn:aws:sns:us-east-1:111111111111:onecli-test-aws-marketplace-events";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });

const signedEnvelope = (event: unknown) => {
  const base: Record<string, string> = {
    Type: "Notification",
    MessageId: "m-app-1",
    TopicArn: TOPIC_ARN,
    Message: JSON.stringify(event),
    Timestamp: new Date().toISOString(),
    SignatureVersion: "2",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/app-level-cert.pem",
  };
  const fields = [
    "Message",
    "MessageId",
    "Subject",
    "Timestamp",
    "TopicArn",
    "Type",
  ];
  let canonical = "";
  for (const f of fields) {
    if (base[f] !== undefined) canonical += `${f}\n${base[f]}\n`;
  }
  const signer = createSign("RSA-SHA256");
  signer.update(canonical, "utf8");
  base.Signature = signer.sign(privateKey, "base64");
  return base;
};

let fetchSpy: MockInstance;

beforeEach(() => {
  state.syncCalls.length = 0;
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(publicKeyPem, { status: 200 }));
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("the real app serves the intake at the path infra subscribes", () => {
  it("POST /v1/billing/aws-marketplace/events dispatches a license event end-to-end", async () => {
    const app = createApiApp({ getSession: async () => null });
    const res = await app.request("/v1/billing/aws-marketplace/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        signedEnvelope({
          "detail-type": "License Updated - Manufacturer",
          source: "aws.agreement-marketplace",
          detail: {
            acceptor: { accountId: "123456789012" },
            license: {
              arn: "arn:aws:license-manager::123456789012:license:l-1",
            },
          },
        }),
      ),
    });
    expect(res.status).toBe(200);
    expect(state.syncCalls).toEqual(["123456789012"]);
  });

  it("no other marketplace surface exists on the app (orphaned routes stay deleted)", async () => {
    const app = createApiApp({ getSession: async () => null });
    const marketplaceRoutes = app.routes.filter(
      (r) => r.path.includes("aws-marketplace") && r.method !== "ALL", // middleware registers as ALL
    );
    expect(marketplaceRoutes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v1/billing/aws-marketplace/events",
    ]);
  });
});
