import { describe, expect } from "vitest";

import { throughMitm } from "../src/mitm.js";
import { scenario } from "../src/scenario.js";

const SECRET = "sk-e2e-mitm-value";

describe("CONNECT interception", () => {
  scenario(
    "terminates TLS with a certificate signed by its own CA",
    async (cx) => {
      const upstream = await cx.upstreamTls();
      await cx.seed();
      const gw = await cx.startGateway();

      // The handshake succeeding at all is the assertion: the client trusts only
      // the gateway's CA, so a leaf it did not mint would fail verification.
      const res = await throughMitm(gw.origin, {
        authority: upstream.authority,
        path: "/v1/models",
        token: cx.ids.agentToken,
        caPath: gw.caPath,
      });

      expect(res.status).toBe(200);
      await upstream.waitForRequests(1);
    },
  );

  scenario("injects a credential inside the tunnel", async (cx) => {
    const upstream = await cx.upstreamTls();
    await cx.seed({
      grantAll: true,
      secrets: [
        { hostPattern: "127.0.0.1", headerName: "x-test-key", value: SECRET },
      ],
    });
    const gw = await cx.startGateway();

    await throughMitm(gw.origin, {
      authority: upstream.authority,
      path: "/v1/models",
      token: cx.ids.agentToken,
      caPath: gw.caPath,
    });

    const [seen] = await upstream.waitForRequests(1);
    expect(seen?.header("x-test-key")).toBe(SECRET);
  });

  scenario("enforces a block rule inside the tunnel", async (cx) => {
    const upstream = await cx.upstreamTls();
    await cx.seed({
      rules: [
        {
          name: "block-in-tunnel",
          action: "block",
          targets: [{ hostPattern: "127.0.0.1", pathPattern: "/blocked*" }],
        },
      ],
    });
    const gw = await cx.startGateway();

    const res = await throughMitm(gw.origin, {
      authority: upstream.authority,
      path: "/blocked/thing",
      token: cx.ids.agentToken,
      caPath: gw.caPath,
    });

    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({ error: "blocked_by_policy" });
    // Enforcement happens after TLS termination but before the upstream leg.
    expect(upstream.requests()).toHaveLength(0);
  });
});
