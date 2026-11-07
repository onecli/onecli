import { describe, expect } from "vitest";

import { defaultConnectionGrant } from "@onecli/api/services/grants-compile";

import { decideApproval, waitForApproval } from "../src/control.js";
import { compiledGrantStack } from "../src/fixtures.js";
import { startForwardProxy } from "../src/forward-proxy.js";
import { throughMitm } from "../src/mitm.js";
import { startHeldRequest, throughProxy } from "../src/proxy.js";
import { scenario, type Cx } from "../src/scenario.js";

/**
 * Twilio through the real binary. As in navan.test.ts, the gateway's outbound
 * client goes through a local recording proxy, so nothing leaves the machine
 * and what the gateway sends is read off the wire.
 *
 * - The stored `sid:secret` pair goes out as `Basic base64(sid:secret)` on
 *   every Twilio product host, and never to Twilio's console or web hosts.
 * - Credentials are per region: an IE1 connection's HTTPS request to the US
 *   host is sent to the same product's IE1 host.
 * - Under the default grant, reading the Account resource (which Twilio
 *   answers with the Auth Token) and approving a verification without its
 *   code are both held for a human, never allowed with the read tools.
 */

const SID = `SK${"a".repeat(32)}`;
const PAIR = `${SID}:tw-secret`;
const BASIC = `Basic ${Buffer.from(PAIR).toString("base64")}`;

const seed = (cx: Cx, region: string) =>
  cx.seed({
    grantAll: true,
    appConnections: [
      {
        provider: "twilio",
        label: "twilio-e2e",
        credentials: { access_token: PAIR, region },
      },
    ],
  });

const proxyEnv = (url: string) => ({
  HTTP_PROXY: url,
  HTTPS_PROXY: url,
  NO_PROXY: "127.0.0.1",
});

describe("twilio", () => {
  scenario("sends the pair as Basic on product hosts only", async (cx) => {
    await seed(cx, "us1");
    const proxy = await startForwardProxy();
    try {
      const gw = await cx.startGateway({ env: proxyEnv(proxy.url) });
      const send = (url: string) =>
        throughProxy(gw.origin, {
          url,
          token: cx.ids.agentToken,
          timeoutMs: 30_000,
        });

      for (const url of [
        "http://api.twilio.com/2010-04-01/Accounts/ACx/Messages.json",
        "http://verify.twilio.com/v2/Services",
        "http://lookups.twilio.com/v2/PhoneNumbers/+14155552671",
      ]) {
        expect((await send(url)).status, url).toBe(200);
      }
      for (const req of proxy.requests()) {
        expect(req.header("authorization"), req.url).toBe(BASIC);
      }

      const before = proxy.requests().length;
      await send("http://www.twilio.com/");
      await send("http://console.twilio.com/");
      for (const req of proxy.requests().slice(before)) {
        expect(req.header("authorization"), req.url).toBeUndefined();
      }
    } finally {
      await proxy.close();
    }
  });

  scenario("an IE1 connection is sent to the IE1 host", async (cx) => {
    await seed(cx, "ie1");
    const proxy = await startForwardProxy();
    try {
      const gw = await cx.startGateway({ env: proxyEnv(proxy.url) });
      // The agent calls the documented US base URL over HTTPS. The forward
      // proxy refuses the tunnel, so the CONNECT authority is the observable.
      await throughMitm(gw.origin, {
        authority: "messaging.twilio.com:443",
        path: "/v1/Services",
        token: cx.ids.agentToken,
        caPath: gw.caPath,
      }).catch(() => undefined);
      const targets = proxy.connects();
      expect(targets).toContain("messaging.dublin.ie1.twilio.com:443");
      expect(targets).not.toContain("messaging.twilio.com:443");
    } finally {
      await proxy.close();
    }
  });

  // The REAL default grant (what a new connection gets): read tools allowed,
  // writes and everything unlisted held. Every held request is DENIED, so
  // nothing egresses.
  scenario(
    "the default grant holds account reads and code-less approvals",
    async (cx) => {
      const grant = defaultConnectionGrant("twilio");
      if (grant.access !== "custom") throw new Error("expected a custom grant");
      await cx.seed({
        withApiKey: true,
        appConnections: [
          {
            provider: "twilio",
            label: "twilio-e2e",
            credentials: { access_token: PAIR, region: "us1" },
          },
        ],
        rules: compiledGrantStack("twilio", grant.allow, {
          ask: grant.ask,
          otherReads: grant.otherReads,
          otherWrites: grant.otherWrites,
        }),
      });
      const gw = await cx.startGateway();

      const cases = [
        {
          url: `http://api.twilio.com/2010-04-01/Accounts/AC${"b".repeat(32)}.json`,
          body: undefined,
          action: "Read account details",
        },
        {
          url: "http://verify.twilio.com/v2/Services/VA1/Verifications/VE1",
          body: "Status=approved",
          action: "Approve verification without its code",
        },
      ];
      for (const c of cases) {
        const held = await startHeldRequest(
          gw.origin,
          {
            method: c.body === undefined ? "GET" : "POST",
            url: c.url,
            token: cx.ids.agentToken,
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: c.body,
          },
          300,
        );
        const row = await waitForApproval(gw, cx.ids.apiKey);
        expect(row.summary?.action).toBe(c.action);
        expect(JSON.stringify(row)).not.toContain("tw-secret");
        await decideApproval(gw, cx.ids.apiKey, row.id, "deny");
        expect((await held.response).status).toBe(403);
      }
    },
  );
});
