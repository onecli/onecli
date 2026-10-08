import { describe, expect } from "vitest";

import { pendingApprovals } from "../src/control.js";
import { throughMitm } from "../src/mitm.js";
import { scenario } from "../src/scenario.js";
import {
  connectTunnel,
  readHttpResponse,
  type OpenTunnel,
} from "../src/tunnel.js";
import type { StubUpstream } from "../src/upstream.js";

/**
 * The open tunnel lane: `CONNECT` with proxy username `open` relays the
 * client's bytes to the origin untouched, instead of terminating TLS.
 *
 * What these prove, in order: the lane is real (the ORIGIN's certificate
 * verifies inside the tunnel, which a terminating gateway cannot produce);
 * it is selected by exactly `open`; it is still gated by the token, by
 * host-level policy and by the destination guard, all BEFORE the 200, and
 * all without the stub seeing a byte; it never injects even where the MITM
 * lane would; and every tunnel leaves one audit row with its byte counts.
 */

/** Speak HTTPS to the stub inside an open tunnel, verifying the STUB's cert. */
const requestInside = async (
  tunnel: OpenTunnel,
  upstream: StubUpstream,
  path: string,
) => {
  if (upstream.cert === undefined) {
    throw new Error("the tunnel test needs a TLS stub");
  }
  const tls = await tunnel.tls({ ca: upstream.cert, servername: "127.0.0.1" });
  tls.write(
    `GET ${path} HTTP/1.1\r\nHost: ${upstream.authority}\r\nConnection: close\r\n\r\n`,
  );
  return readHttpResponse(tls);
};

/** A CONNECT on the open lane that must have been refused, with its reply. */
const expectRefused = async (
  gatewayOrigin: string,
  options: { authority: string; token?: string; user?: string },
) => {
  const result = await connectTunnel(gatewayOrigin, {
    authority: options.authority,
    user: options.user ?? "open",
    ...(options.token === undefined ? {} : { token: options.token }),
  });
  if (result.kind !== "refused") {
    result.tunnel.close();
    throw new Error("expected the CONNECT to be refused, but it opened");
  }
  return result.reply;
};

/** A CONNECT on the open lane that must have opened. */
const expectOpen = async (
  gatewayOrigin: string,
  options: { authority: string; token: string },
) => {
  const result = await connectTunnel(gatewayOrigin, {
    ...options,
    user: "open",
  });
  if (result.kind !== "open") {
    throw new Error(
      `expected the CONNECT to open, got ${String(result.reply.status)}: ${result.reply.body}`,
    );
  }
  return result.tunnel;
};

describe("open tunnel lane", () => {
  scenario(
    "relays the client's own TLS to the origin, untouched",
    async (cx) => {
      const upstream = await cx.upstreamTls();
      upstream.respond({ status: 200, body: '{"origin":"saw me"}' });
      await cx.seed();
      const gw = await cx.startGateway();

      const tunnel = await expectOpen(gw.origin, {
        authority: upstream.authority,
        token: cx.ids.agentToken,
      });
      try {
        // The handshake verifies against the STUB's self-signed cert with no
        // gateway CA in the chain. A gateway that terminated TLS would
        // present its minted leaf and this handshake would fail.
        const res = await requestInside(tunnel, upstream, "/inside");
        expect(res.status).toBe(200);
        expect(res.json()).toEqual({ origin: "saw me" });
      } finally {
        tunnel.close();
      }

      const seen = await upstream.waitForRequests(1);
      expect(seen[0]?.url).toBe("/inside");
    },
  );

  scenario("the default username still takes the MITM lane", async (cx) => {
    const upstream = await cx.upstreamTls();
    await cx.seed();
    const gw = await cx.startGateway();

    // `x:<token>` (the SDK's shape) opens the tunnel too, but inside it the
    // GATEWAY answers the handshake, so the origin's cert cannot verify…
    const asDefault = await connectTunnel(gw.origin, {
      authority: upstream.authority,
      user: "x",
      token: cx.ids.agentToken,
    });
    if (asDefault.kind !== "open") throw new Error("MITM CONNECT refused");
    try {
      await expect(
        requestInside(asDefault.tunnel, upstream, "/"),
      ).rejects.toThrow();
    } finally {
      asDefault.tunnel.close();
    }
    // …while the gateway's CA does: the same CONNECT, driven as the MITM
    // client, reaches the stub through the terminating lane.
    const viaMitm = await throughMitm(gw.origin, {
      authority: upstream.authority,
      path: "/mitm",
      token: cx.ids.agentToken,
      caPath: gw.caPath,
    });
    expect(viaMitm.status).toBe(200);

    // Near-misses stay on the MITM lane as well: the lane is an exact
    // match, never a prefix or a case fold.
    for (const user of ["Open", "OPEN", "open-browser", "browser"]) {
      const near = await connectTunnel(gw.origin, {
        authority: upstream.authority,
        user,
        token: cx.ids.agentToken,
      });
      if (near.kind !== "open") throw new Error(`CONNECT as ${user} refused`);
      try {
        await expect(
          requestInside(near.tunnel, upstream, "/"),
        ).rejects.toThrow();
      } finally {
        near.tunnel.close();
      }
    }
  });

  scenario("refuses an untokened or wrongly tokened CONNECT", async (cx) => {
    const upstream = await cx.upstreamTls();
    await cx.seed();
    const gw = await cx.startGateway();

    const none = await expectRefused(gw.origin, {
      authority: upstream.authority,
    });
    expect(none.status).toBe(407);
    expect(none.header("proxy-authenticate")).toContain("Basic");

    const wrong = await expectRefused(gw.origin, {
      authority: upstream.authority,
      token: "aoc_not_a_real_token",
    });
    expect(wrong.status).toBe(407);

    // The username grants nothing on its own: `open` with no password is the
    // legacy "token in the username" shape, and `open` is not a token.
    const bareOpen = await expectRefused(gw.origin, {
      authority: upstream.authority,
      user: "open",
      token: "",
    });
    expect(bareOpen.status).toBe(407);

    expect(upstream.requests()).toHaveLength(0);
  });

  scenario(
    "a host block rule refuses the tunnel before the 200",
    async (cx) => {
      const upstream = await cx.upstreamTls();
      await cx.seed({
        rules: [
          {
            name: "no-tunnels-here",
            action: "block",
            targets: [{ hostPattern: "127.0.0.1" }],
          },
        ],
      });
      const gw = await cx.startGateway();

      const reply = await expectRefused(gw.origin, {
        authority: upstream.authority,
        token: cx.ids.agentToken,
      });
      expect(reply.status).toBe(403);
      expect(reply.header("x-should-retry")).toBe("false");
      expect(reply.json()).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "no-tunnels-here",
        method: "CONNECT",
      });
      // Refused means refused: a 403 after a dial would still leak the CONNECT.
      expect(upstream.requests()).toHaveLength(0);
    },
  );

  scenario(
    "a path-scoped block does not reach a tunnel, a host-wide one does",
    async (cx) => {
      // A tunnel has no path, so a rule written for `/admin*` cannot know
      // whether the tunnel will carry it, and must not pretend to. The rule
      // the operator wants for a tunnel is the host-wide one.
      const upstream = await cx.upstreamTls();
      await cx.seed({
        rules: [
          {
            name: "block-admin-path",
            action: "block",
            targets: [{ hostPattern: "127.0.0.1", pathPattern: "/admin*" }],
          },
        ],
      });
      const gw = await cx.startGateway();

      const tunnel = await expectOpen(gw.origin, {
        authority: upstream.authority,
        token: cx.ids.agentToken,
      });
      tunnel.close();
    },
  );

  scenario(
    "an approval requirement on the host refuses the tunnel",
    async (cx) => {
      const upstream = await cx.upstreamTls();
      await cx.seed({
        withApiKey: true,
        rules: [
          {
            name: "needs-a-reviewer",
            action: "allow",
            requireApproval: true,
            targets: [{ hostPattern: "127.0.0.1" }],
          },
        ],
      });
      const gw = await cx.startGateway();

      // There is no request a reviewer could see, so nothing can be held: the
      // CONNECT is answered, not parked, and no approval card is created.
      const reply = await expectRefused(gw.origin, {
        authority: upstream.authority,
        token: cx.ids.agentToken,
      });
      expect(reply.status).toBe(403);
      expect(reply.json()).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "Manual approval required",
      });
      expect(upstream.requests()).toHaveLength(0);
      expect(await pendingApprovals(gw, cx.ids.apiKey)).toEqual([]);

      // And the refusal is in the feed, attributed to the rule that caused it.
      expect((await gw.terminate()).code).toBe(0);
      const rows = await cx.db.prisma.requestLog.findMany({
        where: { agentId: cx.ids.agent },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.method).toBe("CONNECT");
      expect(rows[0]?.status).toBe(403);
      expect(rows[0]?.extraData).toMatchObject({
        decision: "blocked",
        blocked_by_rule: "Manual approval required",
        matched_rule_name: "needs-a-reviewer",
      });
    },
  );

  scenario(
    "the destination guard refuses a private host before any dial",
    async (cx) => {
      const upstream = await cx.upstreamTls();
      await cx.seed();
      // Allowlist cleared: the stub's loopback address is now a refusal.
      const gw = await cx.startGateway({
        env: { GATEWAY_ALLOW_PRIVATE_DESTINATIONS: "" },
      });

      for (const authority of [
        upstream.authority,
        `localhost:${String(upstream.port)}`,
        "169.254.169.254:80",
        "[::1]:443",
      ]) {
        const reply = await expectRefused(gw.origin, {
          authority,
          token: cx.ids.agentToken,
        });
        expect(reply.status, authority).toBe(403);
        expect(reply.header("x-should-retry")).toBe("false");
        expect(reply.json()).toMatchObject({
          error: "destination_not_allowed",
        });
      }
      expect(upstream.requests()).toHaveLength(0);
    },
  );

  scenario(
    "never injects: a credentialed host is tunneled with the client's bytes only",
    async (cx) => {
      const upstream = await cx.upstreamTls();
      await cx.seed({
        secrets: [
          {
            hostPattern: "127.0.0.1",
            value: "sk-must-never-cross",
            headerName: "x-api-key",
          },
        ],
        grantAll: true,
      });
      const gw = await cx.startGateway();

      // Control: the MITM lane injects on this host.
      const viaMitm = await throughMitm(gw.origin, {
        authority: upstream.authority,
        path: "/mitm",
        token: cx.ids.agentToken,
        caPath: gw.caPath,
      });
      expect(viaMitm.status).toBe(200);
      const [injected] = await upstream.waitForRequests(1);
      expect(injected?.header("x-api-key")).toBe("sk-must-never-cross");

      // The open lane carries the same host and the request arrives exactly
      // as the client wrote it: no header added, no credential anywhere.
      const tunnel = await expectOpen(gw.origin, {
        authority: upstream.authority,
        token: cx.ids.agentToken,
      });
      try {
        const res = await requestInside(tunnel, upstream, "/tunneled");
        expect(res.status).toBe(200);
      } finally {
        tunnel.close();
      }
      const [, tunneled] = await upstream.waitForRequests(2);
      expect(tunneled?.url).toBe("/tunneled");
      expect(tunneled?.header("x-api-key")).toBeUndefined();
      expect(JSON.stringify(tunneled?.headers)).not.toContain(
        "sk-must-never-cross",
      );
    },
  );

  scenario("every tunnel leaves one row with its byte counts", async (cx) => {
    const upstream = await cx.upstreamTls();
    upstream.respond({ status: 200, body: '{"ok":true}' });
    await cx.seed();
    const gw = await cx.startGateway();

    const tunnel = await expectOpen(gw.origin, {
      authority: upstream.authority,
      token: cx.ids.agentToken,
    });
    const res = await requestInside(tunnel, upstream, "/counted");
    expect(res.status).toBe(200);
    tunnel.close();
    await upstream.waitForRequests(1);

    // Terminating runs the final telemetry flush, so the row is in Postgres
    // when the process exits. The row is written when the tunnel CLOSES
    // (which the close above caused), so it is in the buffer by then.
    expect((await gw.terminate()).code).toBe(0);

    const rows = await cx.db.prisma.requestLog.findMany({
      where: { agentId: cx.ids.agent },
    });
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.method).toBe("CONNECT");
    expect(row?.host).toBe(upstream.authority);
    expect(row?.path).toBe("/");
    expect(row?.status).toBe(200);
    expect(row?.injectionCount).toBe(0);
    expect(row?.extraData).toMatchObject({ decision: "tunneled" });
    const extra = row?.extraData as { bytes_up: number; bytes_down: number };
    // TLS records in both directions: a handshake alone is hundreds of bytes
    // each way, so anything the relay actually carried is well above zero.
    expect(extra.bytes_up).toBeGreaterThan(100);
    expect(extra.bytes_down).toBeGreaterThan(100);
  });

  scenario("an open tunnel does not hold up shutdown", async (cx) => {
    const upstream = await cx.upstreamTls();
    await cx.seed();
    const gw = await cx.startGateway();

    const tunnel = await expectOpen(gw.origin, {
      authority: upstream.authority,
      token: cx.ids.agentToken,
    });
    // Carry bytes first, so the tunnel below is a live pipe and not one
    // that died at the handshake.
    const res = await requestInside(tunnel, upstream, "/live");
    expect(res.status).toBe(200);

    // The stub answered with `Connection: close`, so the ORIGIN side has
    // ended; the client side is still open. A tunnel is a pipe with no
    // completion to wait for: the drain must not hang on it.
    const exit = await gw.terminate();
    tunnel.close();
    expect(exit.code).toBe(0);
    expect(exit.durationMs).toBeLessThan(4_000);
  });
});
