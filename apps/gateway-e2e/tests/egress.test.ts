import { describe, expect } from "vitest";

import { startForwardProxy } from "../src/forward-proxy.js";
import { throughMitm } from "../src/mitm.js";
import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";
import { websocketUpgrade } from "../src/websocket.js";

/**
 * The destination guard: an agent holding only its own proxy token must not
 * be able to reach what the gateway can reach — its own admin plane, the
 * database, cloud metadata — by naming an internal address.
 *
 * Every scenario runs a gateway with the operator allowlist CLEARED (the
 * harness sets it to the stub's `127.0.0.1` for every other suite), and
 * asserts the stub saw nothing: a 403 from a gateway that forwarded first
 * would still be the vulnerability.
 */
const STRICT = { env: { GATEWAY_ALLOW_PRIVATE_DESTINATIONS: "" } };

/**
 * Every way the security report reached loopback: literal, alternate IPv4
 * spellings, the IPv4-mapped IPv6 literal that bypassed host-pattern block
 * rules, and names that RESOLVE to loopback.
 */
const LOOPBACK_SPELLINGS = [
  "127.0.0.1",
  "127.0.0.2",
  "127.1",
  "2130706433",
  "0x7f000001",
  "0.0.0.0",
  "[::1]",
  "[::ffff:127.0.0.1]",
  "localhost",
  "localhost.",
];

const expectRefused = (res: {
  status: number;
  header(n: string): string | undefined;
  json(): unknown;
}) => {
  expect(res.status).toBe(403);
  expect(res.header("x-should-retry")).toBe("false");
  expect(res.json()).toMatchObject({ error: "destination_not_allowed" });
  expect(JSON.stringify(res.json())).toContain(
    "GATEWAY_ALLOW_PRIVATE_DESTINATIONS",
  );
};

describe("destination guard", () => {
  scenario(
    "refuses every loopback spelling over the HTTP proxy",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed();
      const gw = await cx.startGateway(STRICT);

      for (const host of LOOPBACK_SPELLINGS) {
        const res = await throughProxy(gw.origin, {
          url: `http://${host}:${upstream.port}/api/agents`,
          token: cx.ids.agentToken,
        });
        expectRefused(res);
      }
      expect(upstream.requests()).toHaveLength(0);
    },
  );

  scenario("refuses cloud metadata over the HTTP proxy", async (cx) => {
    await cx.seed();
    const gw = await cx.startGateway(STRICT);

    const res = await throughProxy(gw.origin, {
      url: "http://169.254.169.254/latest/meta-data/",
      token: cx.ids.agentToken,
    });
    // Refused before any dial: no connect timeout, a clear 403.
    expectRefused(res);
  });

  scenario("refuses loopback inside a MITM tunnel", async (cx) => {
    const upstream = await cx.upstreamTls();
    await cx.seed();
    const gw = await cx.startGateway(STRICT);

    for (const host of ["127.0.0.1", "localhost"]) {
      const res = await throughMitm(gw.origin, {
        authority: `${host}:${upstream.port}`,
        path: "/api/agents",
        token: cx.ids.agentToken,
        caPath: gw.caPath,
      });
      expectRefused(res);
    }
    expect(upstream.requests()).toHaveLength(0);
  });

  scenario("refuses a loopback WebSocket upgrade", async (cx) => {
    const upstream = await cx.upstreamWs();
    await cx.seed();
    const gw = await cx.startGateway(STRICT);

    const res = await websocketUpgrade(gw.origin, {
      authority: `localhost:${upstream.port}`,
      path: "/ws",
      token: cx.ids.agentToken,
      caPath: gw.caPath,
    });
    expectRefused(res);
    expect(upstream.requests()).toHaveLength(0);
  });

  scenario("every refusal reaches the activity feed", async (cx) => {
    const http = await cx.upstream();
    const ws = await cx.upstreamWs();
    await cx.seed();
    const gw = await cx.startGateway(STRICT);

    // Both halves of the guard — the pre-send IP-literal check and the
    // resolver refusal of a name — plus the WebSocket leg. Nothing was
    // dialed, so the normal forward telemetry never runs; without their own
    // row an agent probing internal addresses would leave no trace.
    expectRefused(
      await throughProxy(gw.origin, {
        url: `http://127.0.0.1:${http.port}/by-ip`,
        token: cx.ids.agentToken,
      }),
    );
    expectRefused(
      await throughProxy(gw.origin, {
        url: `http://localhost:${http.port}/by-name`,
        token: cx.ids.agentToken,
      }),
    );
    expectRefused(
      await websocketUpgrade(gw.origin, {
        authority: `localhost:${ws.port}`,
        path: "/ws",
        token: cx.ids.agentToken,
        caPath: gw.caPath,
      }),
    );

    // Terminating runs the final telemetry flush, so the rows are in
    // Postgres when the process exits.
    expect((await gw.terminate()).code).toBe(0);
    const rows = await cx.db.prisma.requestLog.findMany({
      where: { agentId: cx.ids.agent },
      orderBy: { path: "asc" },
    });
    expect(rows.map((r) => [r.path, r.status, r.injectionCount])).toEqual([
      ["/by-ip", 403, 0],
      ["/by-name", 403, 0],
      ["/ws", 403, 0],
    ]);
    for (const row of rows) {
      expect(row.extraData).toMatchObject({
        decision: "blocked",
        blocked_by_rule: "Non-public destination",
      });
    }
  });

  scenario("the operator allowlist opens exactly what it names", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed();
    // A hostname entry: `localhost` is allowed, its IP spellings are not.
    const gw = await cx.startGateway({
      env: { GATEWAY_ALLOW_PRIVATE_DESTINATIONS: "localhost" },
    });

    const byName = await throughProxy(gw.origin, {
      url: `http://localhost:${upstream.port}/ok`,
      token: cx.ids.agentToken,
    });
    const byIp = await throughProxy(gw.origin, {
      url: `http://127.0.0.1:${upstream.port}/nope`,
      token: cx.ids.agentToken,
    });

    expect(byName.status).toBe(200);
    expectRefused(byIp);
    const seen = await upstream.waitForRequests(1);
    expect(seen.map((r) => r.url)).toEqual(["/ok"]);
  });

  scenario(
    "an operator's environment proxy on a private address still works, and still guards the target",
    async (cx) => {
      // A corporate egress proxy almost always sits on a private address. It
      // is the operator's chosen route, not an agent's destination, so the
      // gateway must dial it without an allowlist entry — while the TARGET an
      // agent names is still judged before anything is sent to the proxy.
      await cx.seed();
      const proxy = await startForwardProxy();
      try {
        // By NAME, not IP: hyper dials an IP-literal proxy without consulting
        // the resolver, so only a named proxy exercises the resolver's
        // exemption. `localhost` resolves to loopback, exactly what a
        // corporate `proxy.corp` on 10.x looks like to the guard.
        const proxyByName = proxy.url.replace("127.0.0.1", "localhost");
        const gw = await cx.startGateway({
          env: {
            GATEWAY_ALLOW_PRIVATE_DESTINATIONS: "",
            HTTP_PROXY: proxyByName,
            HTTPS_PROXY: proxyByName,
          },
        });

        // A public target reaches the proxy (in absolute form, so the proxy
        // records it and answers) even though the proxy itself is on loopback.
        const viaProxy = await throughProxy(gw.origin, {
          url: "http://example.com/public",
          token: cx.ids.agentToken,
          timeoutMs: 30_000,
        });
        expect(viaProxy.status).toBe(200);
        expect(proxy.requests().map((r) => r.url)).toEqual([
          "http://example.com/public",
        ]);

        // A private target is refused before send: the proxy never sees it,
        // by IP or by a name that resolves privately.
        for (const host of ["127.0.0.1", "localhost"]) {
          expectRefused(
            await throughProxy(gw.origin, {
              url: `http://${host}:9/internal`,
              token: cx.ids.agentToken,
            }),
          );
        }
        expect(proxy.requests()).toHaveLength(1);
      } finally {
        await proxy.close();
      }
    },
  );
});
