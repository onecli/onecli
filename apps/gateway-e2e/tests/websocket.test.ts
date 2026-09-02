import { describe, expect, vi } from "vitest";

import {
  decideApproval,
  pendingApprovals,
  waitForApproval,
} from "../src/control.js";
import type { GatewayHandle } from "../src/gateway.js";
import { startHeldRequest, throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";
import { websocketAccept } from "../src/upstream.js";
import { openWebSocket, websocketUpgrade } from "../src/websocket.js";

const SECRET = "sk-e2e-ws-injected";

/**
 * WebSocket handling, end to end.
 *
 * The upstream leg honors the operator's TLS exemptions like every other leg,
 * and the harness exempts `127.0.0.1` by default — so the local stub's
 * self-signed certificate completes the handshake and a full round trip is
 * reachable here. It was not always: this leg used to build its own
 * certificate verifier from compiled-in roots and ignore the configuration,
 * which made a real session impossible to test and made WebSockets fail as an
 * opaque 502 for anyone running an internal CA.
 *
 * That default is also a blind spot, and `websocket upstream TLS` below is
 * what covers it: with every gateway exempting the stub, a build that skipped
 * verification for *every* host would satisfy every other test in this file.
 * That group starts a second, non-exempt gateway so the negative case is real.
 *
 * Most policy arms answer BEFORE any upstream socket is opened, and
 * deliberately name a host that cannot resolve, so they stay honest even if an
 * arm regressed into dialing — the exception is the rate-limit scenario, which
 * needs a real 101 to prove the allowance was spent by a *successful* upgrade.
 *
 * Still out of reach: `WS_IDLE_TIMEOUT` is ten minutes and not configurable,
 * so nothing here covers the idle close.
 */
const WS_HOST = "ws.example.invalid:443";
const WS_PATH = "/ws/v1/stream";

describe("websocket policy", () => {
  scenario("refuses an upgrade blocked by a rule", async (cx) => {
    await cx.seed({
      rules: [
        {
          // Non-ASCII on purpose. The rule name is interpolated straight into
          // the response body, so its byte length exceeds its character count —
          // which is exactly what catches a client that compares
          // `content-length` against a string length instead of a byte count.
          name: "block-café-api",
          action: "block",
          targets: [{ hostPattern: "ws.example.invalid" }],
        },
      ],
    });
    const gw = await cx.startGateway();

    const res = await websocketUpgrade(gw.origin, {
      authority: WS_HOST,
      path: WS_PATH,
      token: cx.ids.agentToken,
      caPath: gw.caPath,
    });

    expect(res.status).toBe(403);
    expect(res.header("x-should-retry")).toBe("false");
    expect(res.json()).toMatchObject({
      error: "blocked_by_policy",
      rule_name: "block-café-api",
    });
    // No "the upstream saw nothing" assertion here: the authority is a host
    // that cannot resolve and is not the stub, so such a check would hold no
    // matter what the gateway did. The routing test below is what proves the
    // WS arm ran; this one pins the response it produces.
  });

  scenario("refuses an upgrade under the Default Rule", async (cx) => {
    await cx.seed({
      // The grant injects the credential; the default must be ORG scope since
      // step 7 — the grant is a workspace ALLOW, and only the org floor
      // survives it (a workspace default would lose first-match and dial out).
      grantAll: true,
      secrets: [
        {
          hostPattern: "ws.example.invalid",
          headerName: "x-test-key",
          value: "sk-e2e-ws",
        },
      ],
      rules: [
        {
          name: "ws-default-deny",
          action: "block",
          isDefault: true,
          scope: "organization",
        },
      ],
    });
    const gw = await cx.startGateway();

    const res = await websocketUpgrade(gw.origin, {
      authority: WS_HOST,
      path: WS_PATH,
      token: cx.ids.agentToken,
      caPath: gw.caPath,
    });

    // The deny-default carve applies on this path too, and the secret above is
    // what satisfies its `has_injections` precondition.
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({ error: "blocked_by_default_policy" });
  });

  scenario("rate-limits an upgrade like any other request", async (cx) => {
    const upstream = await cx.upstreamWs();
    await cx.seed({
      rules: [
        {
          name: "one-ws-per-hour",
          action: "allow",
          rateLimit: 1,
          rateLimitWindow: "hour",
          targets: [{ hostPattern: "127.0.0.1" }],
        },
      ],
    });
    const gw = await cx.startGateway();

    const attempt = () =>
      websocketUpgrade(gw.origin, {
        authority: upstream.authority,
        path: WS_PATH,
        token: cx.ids.agentToken,
        caPath: gw.caPath,
      });

    // Against a real upstream, so the allowance is spent by an upgrade that
    // genuinely succeeded — a rate limit that only ever counted failures
    // would be a much weaker claim.
    const first = await attempt();
    const second = await attempt();

    expect(first.status).toBe(101);
    expect(second.status).toBe(429);
    expect(second.header("retry-after")).toBeDefined();
    expect(second.json()).toMatchObject({ error: "rate_limited", limit: 1 });
  });

  scenario(
    "reports approval as a block and creates no approval",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed({
        withApiKey: true,
        rules: [
          {
            name: "needs-approval",
            action: "allow",
            requireApproval: true,
            targets: [
              { hostPattern: "ws.example.invalid" },
              { hostPattern: "127.0.0.1" },
            ],
          },
        ],
      });
      const gw = await cx.startGateway();

      const res = await websocketUpgrade(gw.origin, {
        authority: WS_HOST,
        path: WS_PATH,
        token: cx.ids.agentToken,
        caPath: gw.caPath,
      });

      // Manual approval is not supported for WebSockets, and the refusal is
      // reported as an ordinary policy block whose `rule_name` is the literal
      // string "Manual approval required" — NOT the rule's own name. A client
      // cannot tell this apart from a real rule that happens to be called that.
      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "Manual approval required",
      });

      // The sharper half: nothing was queued for a human, so an operator
      // watching the approvals list sees no trace of the refusal.
      //
      // Asserted against a live approval from the SAME rule rather than against
      // an empty list. Two reasons: an empty list would make the endpoint
      // long-poll for its full 30 seconds, and — more importantly — "no WS
      // approval" proves nothing if approvals are simply broken. Here the HTTP
      // request demonstrably queues one, and the WS upgrade demonstrably does
      // not.
      const held = await startHeldRequest(
        gw.origin,
        {
          method: "POST",
          url: upstream.url("/v1/send"),
          token: cx.ids.agentToken,
          body: "{}",
        },
        300,
      );

      const pending = await waitForApproval(gw, cx.ids.apiKey);
      expect(pending.url).toContain("/v1/send");
      expect(await pendingApprovals(gw, cx.ids.apiKey)).toHaveLength(1);

      await decideApproval(gw, cx.ids.apiKey, pending.id, "deny");
      await held.response;
    },
  );
});

describe("websocket routing", () => {
  scenario(
    "only treats a request with both headers as an upgrade",
    async (cx) => {
      const upstream = await cx.upstreamWs();
      await cx.seed();
      const gw = await cx.startGateway();

      const attempt = (withUpgradeHeaders: boolean) =>
        websocketUpgrade(gw.origin, {
          authority: upstream.authority,
          path: "/v1/models",
          token: cx.ids.agentToken,
          caPath: gw.caPath,
          withUpgradeHeaders,
        });

      const asUpgrade = await attempt(true);
      const asPlainGet = await attempt(false);

      // One origin, one host, one policy; the upgrade headers are the only
      // variable. The WS arm completes a handshake and the forward arm gets an
      // ordinary response — which is what routing actually means, rather than
      // one arm failing at TLS as it used to.
      expect(asUpgrade.status).toBe(101);

      // Status alone does NOT discriminate, and asserting only that here would
      // be vacuous in the direction that matters. Hardwire `is_websocket_upgrade`
      // to true and this plain GET is routed into the WS handler, which dials
      // the stub, gets an ordinary 200 back because Node only fires `upgrade`
      // for a genuine upgrade, and then hands the non-101 passthrough the
      // upstream's status *verbatim* — 200 again.
      //
      // The payload is what that passthrough cannot fake: it replaces the body
      // with its own plain text and copies no upstream headers at all.
      //
      // `toContain`, not equality: the forward path answers chunked and this
      // client hands back the raw bytes rather than de-chunking them.
      expect(asPlainGet.status).toBe(200);
      expect(asPlainGet.header("content-type")).toBe("application/json");
      expect(asPlainGet.body).toContain("{}");
    },
  );

  scenario(
    "does not route an absolute-form upgrade to the WS path",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed();
      const gw = await cx.startGateway();

      const res = await throughProxy(gw.origin, {
        url: upstream.url("/ws"),
        token: cx.ids.agentToken,
        headers: { upgrade: "websocket", connection: "Upgrade" },
      });

      // Upgrade detection exists only on the CONNECT/MITM path. Here the headers
      // are stripped as hop-by-hop and the request is forwarded as plain HTTP —
      // so the stub answers normally and never sees them.
      expect(res.status).toBe(200);
      const [seen] = await upstream.waitForRequests(1);
      expect(seen?.header("upgrade")).toBeUndefined();
    },
  );
});

describe("websocket upstream TLS", () => {
  scenario(
    "verifies the upstream unless the operator exempted it",
    async (cx) => {
      const upstream = await cx.upstreamWs();
      await cx.seed();

      // Two gateways, one stub, one self-signed certificate. The ONLY difference
      // between them is the exemption, so the pair pins the whole decision:
      // exempted hosts skip verification, everything else still verifies.
      const exempted = await cx.startGateway();
      const verifying = await cx.startGateway({
        env: { GATEWAY_SKIP_VERIFY_HOSTS: "" },
      });

      const upgrade = (gw: GatewayHandle) =>
        websocketUpgrade(gw.origin, {
          authority: upstream.authority,
          path: WS_PATH,
          token: cx.ids.agentToken,
          caPath: gw.caPath,
        });

      // Every other test in this file runs with 127.0.0.1 exempted, so on its own
      // the suite cannot tell "honors the exemption" from "never verifies at all"
      // — a build with verification disabled for every host passes all of them.
      // This is the arm that fails in that case.
      expect((await upgrade(verifying)).status).toBe(502);
      expect((await upgrade(exempted)).status).toBe(101);
    },
  );
});

/**
 * A live session through the gateway, against the local stub.
 *
 * Reachable only because the upstream leg honors the operator's TLS
 * exemptions — reverting that makes every test in this block fail at once,
 * which is what ties the coverage to the fix.
 */
describe("websocket sessions", () => {
  scenario("completes the handshake and filters headers", async (cx) => {
    const upstream = await cx.upstreamWs();
    upstream.respondUpgrade({
      headers: { "set-cookie": "upstream=secret", "x-upstream": "private" },
    });
    await cx.seed();
    const gw = await cx.startGateway();

    const ws = await openWebSocket(gw.origin, {
      authority: upstream.authority,
      path: WS_PATH,
      token: cx.ids.agentToken,
      caPath: gw.caPath,
      headers: {
        "x-custom-header": "kept",
        authorization: "Bearer client-supplied",
        te: "trailers",
        "x-onecli-connection-id": "bogus",
      },
    });

    expect(ws.status).toBe(101);
    // Computed by the stub from the key this client generated, so it fails if
    // the key is not forwarded, if the accept is not returned, or if the 101
    // itself is not propagated.
    expect(ws.header("sec-websocket-accept")).toBe(websocketAccept(ws.key));

    // Only the handshake headers come back. Copying everything would hand the
    // agent an upstream session cookie.
    expect(ws.header("set-cookie")).toBeUndefined();
    expect(ws.header("x-upstream")).toBeUndefined();

    const [seen] = await upstream.waitForUpgrades(1);
    expect(seen?.header("x-custom-header")).toBe("kept");
    // Forwarded on purpose — the client's own credential is its business.
    expect(seen?.header("authorization")).toBe("Bearer client-supplied");
    // Hop-by-hop, and the gateway's internal routing header: neither belongs
    // upstream.
    expect(seen?.header("te")).toBeUndefined();
    expect(seen?.header("x-onecli-connection-id")).toBeUndefined();
    // The gateway sets Host itself, so the client's copy must be dropped —
    // and only counting the raw list can tell that apart from Node collapsing
    // a duplicate.
    const hostHeaders = (seen?.rawHeaders ?? []).filter(
      (h) => h.toLowerCase() === "host",
    );
    expect(hostHeaders).toHaveLength(1);

    ws.close();
  });

  scenario("pipes bytes in both directions", async (cx) => {
    const upstream = await cx.upstreamWs();
    await cx.seed();
    const gw = await cx.startGateway();

    const ws = await openWebSocket(gw.origin, {
      authority: upstream.authority,
      path: WS_PATH,
      token: cx.ids.agentToken,
      caPath: gw.caPath,
    });
    expect(ws.status).toBe(101);
    await upstream.waitForUpgrades(1);

    // Distinct tokens rather than an echo: a gateway that looped bytes back
    // internally would satisfy an echo test without the upstream ever seeing
    // them.
    ws.send("PING-one\n");
    await vi.waitFor(() =>
      expect(upstream.upgrades()[0]?.received()).toContain("PING-one\n"),
    );
    upstream.sendToClient("PONG-one\n");
    expect(await ws.receive("\n")).toBe("PONG-one\n");

    // A second exchange on the same socket. A one-shot splice, or one that
    // buffered rather than streamed, cannot produce this — which is the
    // negative control a timing bound would otherwise have to make.
    ws.send("PING-two\n");
    await vi.waitFor(() =>
      expect(upstream.upgrades()[0]?.received()).toContain("PING-two\n"),
    );
    upstream.sendToClient("PONG-two\n");
    expect(await ws.receive("\n")).toBe("PONG-two\n");

    ws.close();
  });

  scenario("injects credentials into the handshake", async (cx) => {
    const upstream = await cx.upstreamWs();
    await cx.seed({
      grantAll: true,
      secrets: [
        { hostPattern: "127.0.0.1", headerName: "x-test-key", value: SECRET },
        {
          hostPattern: "127.0.0.1",
          pathTemplate: "/bot{value}",
          value: SECRET,
        },
        // Scoped to a host this test never reaches: a gateway that injected
        // unconditionally would fail here.
        {
          hostPattern: "api.example.invalid",
          headerName: "x-wrong-host",
          value: SECRET,
        },
      ],
    });
    const gw = await cx.startGateway();

    const ws = await openWebSocket(gw.origin, {
      authority: upstream.authority,
      path: "/botPLACEHOLDER/stream",
      token: cx.ids.agentToken,
      caPath: gw.caPath,
    });

    expect(ws.status).toBe(101);
    const [seen] = await upstream.waitForUpgrades(1);
    // The product, on this leg: a credential the client never held arrives
    // upstream, decrypted from a real stored ciphertext.
    expect(seen?.header("x-test-key")).toBe(SECRET);
    // The path rewrite applies to the handshake target too. Asserting the URL
    // catches a regression that sends the original path — invisible to the
    // header assertion, and it leaves the placeholder in the request.
    expect(seen?.url).toBe(`/bot${SECRET}/stream`);
    expect(seen?.header("x-wrong-host")).toBeUndefined();

    ws.close();
  });

  scenario(
    "passes the upstream's refusal status through, and nothing else",
    async (cx) => {
      const upstream = await cx.upstreamWs();
      // A status the gateway never produces itself on this path, so the
      // assertion cannot pass against one that mapped every refusal to a
      // constant.
      upstream.respondUpgrade({
        status: 418,
        headers: {
          "set-cookie": "upstream=secret",
          "content-type": "text/html",
        },
        body: "<p>no</p>",
      });
      await cx.seed();
      const gw = await cx.startGateway();

      const res = await websocketUpgrade(gw.origin, {
        authority: upstream.authority,
        path: WS_PATH,
        token: cx.ids.agentToken,
        caPath: gw.caPath,
      });

      expect(res.status).toBe(418);
      // The gateway substitutes its own plain-text explanation and copies no
      // upstream headers at all — so a client sees neither the upstream's body
      // nor its content type.
      expect(res.body).toBe("WebSocket upgrade rejected by upstream (418)");
      expect(res.header("content-type")).toBeUndefined();
      expect(res.header("set-cookie")).toBeUndefined();
    },
  );
});
