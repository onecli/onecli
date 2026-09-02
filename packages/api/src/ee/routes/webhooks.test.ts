import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Resend intake is fail-closed, end to end ────────────────────────────────
//
// The mount-walk (licensing/ee-mount-lock.test.ts) pins the unconfigured 500;
// this suite drives the CONFIGURED router. The load-bearing fact it protects:
// the provider issues ONE SIGNING SECRET PER ENDPOINT, so /resend and
// /inbound read different variables — and neither endpoint's secret may
// authenticate the other's traffic. Sharing one variable (the shape this
// suite would have accepted before) leaves whichever endpoint it does not
// belong to refusing every delivery in production.
//
// Signed vectors are computed with the same primitives the verifier
// documents, so a raw-body drift between middleware and verification surfaces
// here; the external conformance anchor lives in webhook-signature.test.ts.

// The intake is edition-dark off cloud, and `IS_CLOUD` is frozen at module
// load — so this file pins cloud before the graph loads. The onprem arm (the
// 404) is webhooks.onprem.test.ts; neither can live in the other's file.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  delete process.env.EDITION;
});

const store = vi.hoisted(() => ({
  webhookRows: [] as Record<string, unknown>[],
}));

vi.mock("@onecli/db", () => ({
  db: {
    resendWebhook: {
      create: async (args: { data: Record<string, unknown> }) => {
        store.webhookRows.push(args.data);
        return args.data;
      },
      updateMany: async () => ({ count: 0 }),
      findMany: async () => [],
    },
    resendBadEmail: {
      create: async () => ({}),
      findFirst: async () => null,
    },
  },
}));

import { webhookRoutes } from "./webhooks";

/** Distinct per endpoint, exactly as the Resend dashboard issues them. */
const DELIVERY_SECRET = `whsec_${Buffer.from("delivery-endpoint-key-32-bytes!!").toString("base64")}`;
const INBOUND_SECRET = `whsec_${Buffer.from("inbound-endpoint-key-32-bytes!!!").toString("base64")}`;

const signedHeaders = (
  body: string,
  secret: string,
  overrides?: { signature?: string },
) => {
  const id = "msg_test";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature =
    overrides?.signature ??
    `v1,${createHmac(
      "sha256",
      Buffer.from(secret.slice("whsec_".length), "base64"),
    )
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64")}`;
  return {
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": signature,
    "content-type": "application/json",
  };
};

const DELIVERY_EVENT = JSON.stringify({
  type: "email.delivered",
  data: { subject: "s", from: "a@b.c", to: ["x@y.z"] },
});
const INBOUND_EVENT = JSON.stringify({
  type: "email.received",
  data: { email_id: "e1", from: "a@b.c", to: ["x@reply.onecli.sh"] },
});

beforeEach(() => {
  store.webhookRows = [];
  vi.stubEnv("RESEND_WEBHOOK_SECRET", DELIVERY_SECRET);
  vi.stubEnv("RESEND_INBOUND_WEBHOOK_SECRET", INBOUND_SECRET);
});

afterEach(() => vi.unstubAllEnvs());

describe("resend webhook intake (signature-gated, per endpoint)", () => {
  it("a Resend-signed delivery event is processed", async () => {
    const res = await webhookRoutes().request("/resend", {
      method: "POST",
      headers: signedHeaders(DELIVERY_EVENT, DELIVERY_SECRET),
      body: DELIVERY_EVENT,
    });
    expect(res.status).toBe(200);
    expect(store.webhookRows).toHaveLength(1);
    expect(store.webhookRows[0]).toMatchObject({
      eventType: "email.delivered",
    });
  });

  it("the inbound endpoint accepts ITS OWN secret", async () => {
    const res = await webhookRoutes().request("/inbound", {
      method: "POST",
      headers: signedHeaders(INBOUND_EVENT, INBOUND_SECRET),
      body: INBOUND_EVENT,
    });
    // Past the gate: the handler answers 200 (its own errors stay 200 so the
    // provider never retries our bugs forever).
    expect(res.status).toBe(200);
  });

  // THE regression this design exists for: one shared variable would make one
  // of the two live endpoints refuse every delivery, and a leaked secret would
  // authenticate both surfaces.
  it("each endpoint REFUSES the other endpoint's secret", async () => {
    const wrongForDelivery = await webhookRoutes().request("/resend", {
      method: "POST",
      headers: signedHeaders(DELIVERY_EVENT, INBOUND_SECRET),
      body: DELIVERY_EVENT,
    });
    expect(wrongForDelivery.status).toBe(401);
    expect(store.webhookRows).toEqual([]);

    const wrongForInbound = await webhookRoutes().request("/inbound", {
      method: "POST",
      headers: signedHeaders(INBOUND_EVENT, DELIVERY_SECRET),
      body: INBOUND_EVENT,
    });
    expect(wrongForInbound.status).toBe(401);
  });

  it("each endpoint is configured independently — one unset does not darken the other", async () => {
    vi.stubEnv("RESEND_INBOUND_WEBHOOK_SECRET", "");
    const inbound = await webhookRoutes().request("/inbound", {
      method: "POST",
      headers: signedHeaders(INBOUND_EVENT, INBOUND_SECRET),
      body: INBOUND_EVENT,
    });
    expect(inbound.status).toBe(500);

    const delivery = await webhookRoutes().request("/resend", {
      method: "POST",
      headers: signedHeaders(DELIVERY_EVENT, DELIVERY_SECRET),
      body: DELIVERY_EVENT,
    });
    expect(delivery.status).toBe(200);
  });

  it("a rotation list keeps the old secret valid alongside the new one", async () => {
    const rotated = `whsec_${Buffer.from("rotated-delivery-key-32-bytes!!!!").toString("base64")}`;
    vi.stubEnv("RESEND_WEBHOOK_SECRET", `${DELIVERY_SECRET} ${rotated}`);
    for (const secret of [DELIVERY_SECRET, rotated]) {
      const res = await webhookRoutes().request("/resend", {
        method: "POST",
        headers: signedHeaders(DELIVERY_EVENT, secret),
        body: DELIVERY_EVENT,
      });
      expect(res.status).toBe(200);
    }
    expect(store.webhookRows).toHaveLength(2);
  });

  it("an unsigned request is refused 401 and writes nothing", async () => {
    const res = await webhookRoutes().request("/resend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: DELIVERY_EVENT,
    });
    expect(res.status).toBe(401);
    expect(store.webhookRows).toEqual([]);
  });

  it("a tampered body dies on the signature (verified over the RAW body)", async () => {
    const res = await webhookRoutes().request("/resend", {
      method: "POST",
      headers: signedHeaders(DELIVERY_EVENT, DELIVERY_SECRET),
      body: JSON.stringify({ type: "email.complained", data: {} }),
    });
    expect(res.status).toBe(401);
    expect(store.webhookRows).toEqual([]);
  });

  it("unconfigured intake rejects everything with 500 (fail-closed)", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
    const res = await webhookRoutes().request("/resend", {
      method: "POST",
      headers: signedHeaders(DELIVERY_EVENT, DELIVERY_SECRET),
      body: DELIVERY_EVENT,
    });
    expect(res.status).toBe(500);
    expect(store.webhookRows).toEqual([]);
  });
});
