import { describe, expect } from "vitest";

import { decideApproval, waitForApproval } from "../src/control.js";
import { waitForConnectionRefused } from "../src/gateway.js";
import { startHeldRequest } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";
import { openWebSocket } from "../src/websocket.js";

/**
 * What the gateway does when it is asked to stop.
 *
 * Until this existed the binary had no signal handler at all — and because it
 * runs as PID 1 in its container, the kernel discarded SIGTERM outright, so
 * every deploy waited out the orchestrator's stop timeout and ended in a
 * SIGKILL that cut live requests mid-flight.
 *
 * These tests drive the real signal and assert on what an operator and an agent
 * can actually observe: the exit, its timing, and what happened to the work
 * that was in progress.
 */
describe("graceful shutdown", () => {
  scenario("exits promptly and cleanly when idle", async (cx) => {
    const gw = await cx.startGateway();

    // Leaves an idle keep-alive connection parked behind undici's global
    // agent — so the drain has something real to close. Without it this test
    // would pass against a gateway that only ever handles the trivial case.
    expect((await fetch(`${gw.origin}/healthz`)).status).toBe(200);

    const exit = await gw.terminate();

    // `code 0, signal null` is unproducible without a handler: an unhandled
    // SIGTERM reports `code null, signal "SIGTERM"`.
    expect(exit.code).toBe(0);
    expect(exit.signal).toBeNull();
    expect(exit.durationMs).toBeLessThan(4_000);

    // The log contract the suite depends on, pinned here and nowhere else.
    await gw.waitForLog("shutdown started", 1_000);
    await gw.waitForLog("drain complete", 1_000);
  });

  scenario("finishes an in-flight request but refuses new ones", async (cx) => {
    const upstream = await cx.upstream();
    // Held well inside the drain deadline: past it the gateway is entitled to
    // cut this request, and the test would be asserting the wrong thing.
    upstream.respond({ status: 200, body: '{"done":true}', delayMs: 2_500 });
    await cx.seed();
    const gw = await cx.startGateway();

    const held = await startHeldRequest(
      gw.origin,
      { url: upstream.url("/v1/slow"), token: cx.ids.agentToken },
      100,
    );
    // The forward leg has reached the upstream and no response byte has been
    // written back — the request is genuinely in flight when the signal lands.
    await upstream.waitForRequests(1);

    const exit = gw.terminate();

    // Refusal must arrive strictly before the upstream would have answered.
    // That overlap is the proof: the listener closed while this process was
    // still on the hook for a response it had not yet sent.
    await waitForConnectionRefused(gw.origin, 2_000);

    const res = await held.response;
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"done":true}');
    expect((await exit).code).toBe(0);
  });

  scenario("cuts a stuck request at the drain deadline", async (cx) => {
    const upstream = await cx.upstream();
    // Never answers. The gateway tracks this connection, so without a deadline
    // the drain would wait on it forever.
    upstream.respond({ status: 200, body: "{}", delayMs: 60_000 });
    await cx.seed();
    // The knob is the WHOLE shutdown budget; the drain gets what is left after
    // the reserve held back for the flush and the pool close. 5 total leaves
    // the drain ~1s, well clear of the 9s default.
    const gw = await cx.startGateway({
      env: { GATEWAY_SHUTDOWN_TIMEOUT_SECS: "5" },
    });

    const held = await startHeldRequest(
      gw.origin,
      { url: upstream.url("/v1/never"), token: cx.ids.agentToken },
      100,
    );
    await upstream.waitForRequests(1);

    const exit = await gw.terminate();

    // Lower bound: the deadline is a grace period, not an instant cut — the
    // request was given its second before being abandoned. Upper bound: the
    // env override was honored, so a hardcoded 5s default lands outside.
    expect(exit.durationMs).toBeGreaterThan(700);
    expect(exit.durationMs).toBeLessThan(4_000);
    expect(exit.code).toBe(0);

    await expect(held.response).rejects.toThrow();
  });

  scenario("an open WebSocket does not delay shutdown", async (cx) => {
    const upstream = await cx.upstreamWs();
    await cx.seed();
    const gw = await cx.startGateway();

    const ws = await openWebSocket(gw.origin, {
      authority: upstream.authority,
      path: "/ws/v1/stream",
      token: cx.ids.agentToken,
      caPath: gw.caPath,
    });
    expect(ws.status).toBe(101);

    // Carry a byte before signalling. A 101 only proves the pipe was built;
    // one that had since died would still let the gateway exit fast, and the
    // timing assertion below would then pass for the wrong reason.
    await upstream.waitForUpgrades(1);
    upstream.sendToClient("LIVE\n");
    expect(await ws.receive("\n")).toBe("LIVE\n");

    const exit = await gw.terminate();
    ws.close();

    // A WebSocket is a pipe, not a request: it has no completion to wait for,
    // so the drain deliberately does not track it. The in-flight-request test
    // above is the other half — that one the drain DOES wait for, and the
    // contrast is the point.
    expect(exit.code).toBe(0);
    expect(exit.durationMs).toBeLessThan(4_000);
  });

  scenario("drains the same way on SIGINT", async (cx) => {
    const gw = await cx.startGateway();

    // SIGTERM and SIGINT are separate registrations; handling only one is a
    // one-line omission that would leave Ctrl-C killing the process outright.
    const exit = await gw.terminate({ signal: "SIGINT" });

    expect(exit.code).toBe(0);
    expect(exit.signal).toBeNull();
  });
});

const APPROVAL_WORLD = {
  withApiKey: true,
  rules: [
    {
      name: "needs-approval",
      action: "allow" as const,
      requireApproval: true,
      targets: [{ hostPattern: "127.0.0.1" }],
    },
  ],
};

describe("shutdown with work held for approval", () => {
  scenario("releases a frozen request and clears its card", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed(APPROVAL_WORLD);
    const first = await cx.startGateway();

    const approved = await startHeldRequest(
      first.origin,
      {
        method: "POST",
        url: upstream.url("/v1/send"),
        token: cx.ids.agentToken,
        body: "{}",
      },
      300,
    );
    const approval = await waitForApproval(first, cx.ids.apiKey);

    // A second gateway on the same database and Redis — a reviewer's browser
    // talking to another instance. It can decide this approval right now, which
    // is what makes the identical call after shutdown meaningful.
    const second = await cx.startGateway();
    const beforeShutdown = await decideApproval(
      second,
      cx.ids.apiKey,
      approval.id,
      "approve",
    );
    expect(beforeShutdown.status).toBe(200);
    expect((await approved.response).status).toBe(200);

    // That approval resolved the first held request, so run a second one to
    // observe what shutdown does to a request nobody has decided.
    const stranded = await startHeldRequest(
      first.origin,
      {
        method: "POST",
        url: upstream.url("/v1/stranded"),
        token: cx.ids.agentToken,
        body: "{}",
      },
      300,
    );
    const pending = await waitForApproval(first, cx.ids.apiKey);
    expect(pending.url).toContain("/v1/stranded");

    // Nothing has been released yet, so the audit log cannot already show one.
    // This is what makes the check after shutdown evidence of the final flush
    // rather than of a row that happened to be there all along.
    expect(
      await cx.db.prisma.requestLog.count({ where: { status: 503 } }),
    ).toBe(0);

    const exit = await first.terminate();
    expect(exit.code).toBe(0);

    // The agent is told to retry rather than left hanging, and — the half that
    // matters most — never told it was denied. A restart is not a decision.
    const res = await stranded.response;
    expect(res.status).toBe(503);
    expect(res.json()).toMatchObject({ error: "gateway_restarting" });

    // And the release aborted the request rather than quietly letting it
    // through: only the approved one reached the upstream.
    expect(upstream.requests()).toHaveLength(1);

    // The card is gone, so a reviewer cannot approve a request whose client
    // has already been sent away. Asserted through the decision endpoint
    // rather than the list, which long-polls for 30s when nothing is pending.
    const afterShutdown = await decideApproval(
      second,
      cx.ids.apiKey,
      pending.id,
      "approve",
    );
    expect(afterShutdown.status).toBe(404);

    // The release is in the audit log. This is the only assertion anywhere on
    // the final telemetry flush: it is the one event generated during shutdown
    // itself, so it exists in the buffer at the moment the process is exiting
    // and reaches Postgres only if that last flush actually runs.
    const released = await cx.db.prisma.requestLog.findMany({
      where: { status: 503 },
    });
    expect(released).toHaveLength(1);
    expect(released[0]?.path).toContain("/v1/stranded");
  });

  scenario(
    "answers a waiting approval poll instead of cutting it",
    async (cx) => {
      await cx.seed({ withApiKey: true });
      const gw = await cx.startGateway();

      // Nothing is pending, so the gateway holds this open for its full 30s
      // window — long enough to pin the entire drain if shutdown ignored it.
      const poll = fetch(`${gw.origin}/v1/approvals/pending`, {
        headers: { authorization: `Bearer ${cx.ids.apiKey}` },
      });
      await new Promise((r) => setTimeout(r, 300));

      const exit = await gw.terminate();

      // A real response, not a severed connection: the poller learns there is
      // nothing to review and re-polls against the replacement instance.
      const res = await poll;
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ requests: [] });
      expect(exit.code).toBe(0);
      expect(exit.durationMs).toBeLessThan(4_000);
    },
  );
});
