import { describe, expect } from "vitest";

import { startForwardProxy } from "../src/forward-proxy.js";
import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * Navan through the real binary: a client_credentials connection on
 * `api.navan.com`, where EU tenants must also carry `X-ta-region: EU`.
 *
 * The region header is driven by the stored `ta_region` credential field, so
 * these pin both halves of that contract: an EU connection gets the bearer
 * AND the header, a US connection (no field) gets the bearer only. The
 * expired case proves the re-minted token is the one injected.
 *
 * As in credential-refresh.test.ts, the agent's request is recorded by a local
 * forward proxy (nothing leaves the machine) and the token URL points at a
 * local stub, which only a seeded row can do: the connect path allowlists
 * real Navan token hosts.
 */

const NAVAN_URL =
  "http://api.navan.com/v1/bookings?createdFrom=2026-01-01&createdTo=2026-01-31";

const FAR_FUTURE = 4_102_444_800;

const navanConnection = (tokenUrl: string, extra: Record<string, unknown>) => ({
  grantAll: true,
  appConnections: [
    {
      provider: "navan",
      label: "navan-e2e",
      credentials: {
        type: "client_credentials",
        access_token: "navan-live",
        expires_at: FAR_FUTURE,
        client_id: "e2e-navan-client",
        client_secret: "e2e-navan-secret",
        token_url: tokenUrl,
        ...extra,
      },
    },
  ],
});

describe("navan", () => {
  scenario("EU connection gets the bearer and X-ta-region", async (cx) => {
    const tokens = await cx.upstream();
    await cx.seed(navanConnection(tokens.url("/token"), { ta_region: "EU" }));
    const proxy = await startForwardProxy();

    try {
      const gw = await cx.startGateway({
        env: {
          HTTP_PROXY: proxy.url,
          HTTPS_PROXY: proxy.url,
          NO_PROXY: "127.0.0.1",
        },
      });

      const res = await throughProxy(gw.origin, {
        url: NAVAN_URL,
        token: cx.ids.agentToken,
        timeoutMs: 30_000,
      });
      expect(res.status).toBe(200);

      const seen = proxy.requests()[0];
      expect(seen?.header("authorization")).toBe("Bearer navan-live");
      expect(seen?.header("x-ta-region")).toBe("EU");
      // A fresh token is used as-is: no token request.
      expect(tokens.requests()).toHaveLength(0);
    } finally {
      await proxy.close();
    }
  });

  scenario("US connection gets the bearer only", async (cx) => {
    const tokens = await cx.upstream();
    await cx.seed(navanConnection(tokens.url("/token"), {}));
    const proxy = await startForwardProxy();

    try {
      const gw = await cx.startGateway({
        env: {
          HTTP_PROXY: proxy.url,
          HTTPS_PROXY: proxy.url,
          NO_PROXY: "127.0.0.1",
        },
      });

      const res = await throughProxy(gw.origin, {
        url: NAVAN_URL,
        token: cx.ids.agentToken,
        timeoutMs: 30_000,
      });
      expect(res.status).toBe(200);

      const seen = proxy.requests()[0];
      expect(seen?.header("authorization")).toBe("Bearer navan-live");
      expect(seen?.header("x-ta-region")).toBeUndefined();
    } finally {
      await proxy.close();
    }
  });

  scenario("an expired token is re-minted before injection", async (cx) => {
    const tokens = await cx.upstream();
    tokens.respond({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_token: "navan-fresh", expires_in: 43199 }),
    });
    await cx.seed(
      navanConnection(tokens.url("/token"), {
        ta_region: "EU",
        access_token: "navan-stale",
        expires_at: 1,
      }),
    );
    const proxy = await startForwardProxy();

    try {
      const gw = await cx.startGateway({
        env: {
          HTTP_PROXY: proxy.url,
          HTTPS_PROXY: proxy.url,
          NO_PROXY: "127.0.0.1",
        },
      });

      const res = await throughProxy(gw.origin, {
        url: NAVAN_URL,
        token: cx.ids.agentToken,
        timeoutMs: 30_000,
      });
      expect(res.status).toBe(200);

      // client_credentials re-mint: Basic auth, no refresh token, no scope.
      const mint = tokens.requests()[0];
      expect(mint?.header("authorization")).toBe(
        `Basic ${Buffer.from("e2e-navan-client:e2e-navan-secret").toString("base64")}`,
      );
      expect(mint?.body).toBe("grant_type=client_credentials");

      const seen = proxy.requests()[0];
      expect(seen?.header("authorization")).toBe("Bearer navan-fresh");
      expect(seen?.header("x-ta-region")).toBe("EU");
    } finally {
      await proxy.close();
    }
  });
});
