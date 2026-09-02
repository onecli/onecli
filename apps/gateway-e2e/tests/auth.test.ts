import { describe, expect } from "vitest";

import { connectThroughProxy, throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

describe("proxy authentication", () => {
  scenario(
    "rejects an unknown agent token on the absolute-form path",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed();
      const gw = await cx.startGateway();

      const res = await throughProxy(gw.origin, {
        url: upstream.url("/v1/models"),
        token: "aoc_not_a_real_token",
      });

      expect(res.status).toBe(407);
      expect(res.header("proxy-authenticate")).toContain("Basic");
      // Rejection must happen before egress, not after.
      expect(upstream.requests()).toHaveLength(0);
    },
  );

  scenario("rejects an unknown agent token on CONNECT", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed();
    const gw = await cx.startGateway();

    // CONNECT resolves separately from the absolute-form path, and the two have
    // drifted before — pin them independently so a future unification is visible.
    const res = await connectThroughProxy(gw.origin, upstream.authority, {
      token: "aoc_not_a_real_token",
    });

    expect(res.status).toBe(407);
    expect(upstream.requests()).toHaveLength(0);
  });

  scenario("refuses an untokened tunnel outright", async (cx) => {
    // The egress-lockdown boundary's gateway half: an untokened tunnel is
    // UNGOVERNED — no policy, no injection, no audit — so the gateway
    // unconditionally refuses it rather than open a relay. This test is THE
    // pin of that 407 posture — the only automated guard on it.
    const upstream = await cx.upstream();
    await cx.seed();
    const gw = await cx.startGateway();

    const connect = await connectThroughProxy(gw.origin, upstream.authority);
    expect(connect.status).toBe(407);

    // BOTH proxy paths, not just CONNECT: an absolute-form `GET
    // http://host/…` reaches an arbitrary host the same way, so the guard
    // must refuse it too (it did not, before step 13 — a plain-HTTP open
    // relay hid behind the CONNECT-only guard).
    const absolute = await throughProxy(gw.origin, {
      url: upstream.url("/v1/models"),
    });
    expect(absolute.status).toBe(407);

    // Refused before egress on either path: nothing reached the upstream.
    expect(upstream.requests()).toHaveLength(0);

    // And a TOKENED request still opens — the guard gates anonymity, not
    // agents (the whole hosted path depends on this arm staying open).
    const tokened = await connectThroughProxy(gw.origin, upstream.authority, {
      token: cx.ids.agentToken,
    });
    expect(tokened.status).toBe(200);
  });
});
