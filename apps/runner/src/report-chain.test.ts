import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEvent } from "@onecli/agent-protocol";
import { ControlPlaneError } from "./control-plane";
import { createReportChain } from "./report-chain";

/**
 * The report chain's laws: reports reach the control plane one at a time in
 * the order they were made; a failed post is dropped with a warning; and a
 * turn's end whose post PROVABLY never applied is re-sent (in order, bounded,
 * fairly across sandboxes) until it lands, while one that may have landed is
 * never repeated.
 */

const finished = (turnId: string, sandboxId = "sb-1"): RunnerEvent => ({
  kind: "turn.finished",
  sandboxId,
  conversationId: "c-1",
  turnId,
  status: "done",
});
const events = (turnId: string): RunnerEvent => ({
  kind: "turn.events",
  sandboxId: "sb-1",
  conversationId: "c-1",
  turnId,
  events: [{ type: "text", text: "hi" }],
});

/** Never sent: the api's listener is closed (an api mid-restart). */
const refused = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    }),
  });
/** May have landed: the socket dropped after the request went out. */
const reset = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
  });

/** A control plane that answers the scripted failures, then accepts. */
const controlPlane = (failures: unknown[] = []) => {
  const delivered: RunnerEvent[] = [];
  let posts = 0;
  return {
    delivered,
    posts: () => posts,
    post: async (batch: RunnerEvent[]) => {
      posts += 1;
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      delivered.push(...batch);
    },
  };
};

const chainFor = (api: ReturnType<typeof controlPlane>) => {
  const warns: string[] = [];
  const chain = createReportChain({
    post: api.post,
    warn: (message) => warns.push(message),
  });
  return { chain, warns };
};

/** Run every backoff to completion: an hour of re-sends, all cheap here. */
const settle = async (chain: { drained: () => Promise<void> }) => {
  await vi.runAllTimersAsync();
  await chain.drained();
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("report chain", () => {
  it("posts in the order reports were made", async () => {
    const api = controlPlane();
    const { chain } = chainFor(api);
    chain.report(events("t1"));
    chain.report(finished("t1"));
    await settle(chain);
    expect(api.delivered.map((e) => e.kind)).toEqual([
      "turn.events",
      "turn.finished",
    ]);
  });

  it("re-sends a turn's end that never left until the control plane is back (an api restart)", async () => {
    // MUTATION-PROOF: drop the re-send and the conversation stays wedged
    // behind a turn that already finished.
    const api = controlPlane([refused(), refused(), refused()]);
    const { chain, warns } = chainFor(api);
    chain.report(finished("t1"));
    await settle(chain);
    expect(api.delivered).toEqual([finished("t1")]);
    expect(api.posts()).toBe(4);
    expect(warns[0]).toBe("failed to report a turn's end; re-sending it");
  });

  it("re-sends on a status that proves nothing applied (503)", async () => {
    const api = controlPlane([new ControlPlaneError(503, "x")]);
    const { chain } = chainFor(api);
    chain.report(finished("t1"));
    await settle(chain);
    expect(api.delivered).toEqual([finished("t1")]);
  });

  it.each([
    ["a reset", reset()],
    ["a 502", new ControlPlaneError(502, "x")],
    ["a 403", new ControlPlaneError(403, "x")],
  ])(
    "never re-sends a turn's end after %s (it may have landed, or cannot succeed)",
    async (_label, failure) => {
      // A stale duplicate close is not harmless: a death report re-sent
      // after its first copy revived the turn fails the fresh retry.
      // MUTATION-PROOF: re-sending on any failure posts twice here.
      const api = controlPlane([failure]);
      const { chain, warns } = chainFor(api);
      chain.report(finished("t1"));
      await settle(chain);
      expect(api.posts()).toBe(1);
      expect(api.delivered).toEqual([]);
      expect(warns).toEqual(["failed to report a supervisor message"]);
    },
  );

  it("stops re-sending once a re-send may have landed", async () => {
    const api = controlPlane([refused(), reset()]);
    const { chain, warns } = chainFor(api);
    chain.report(finished("t1"));
    await settle(chain);
    expect(api.posts()).toBe(2);
    expect(warns).toContain("a turn's end may have landed; not re-sending it");
  });

  it.each(["agent_start_failed", "agent_restarted"])(
    "never re-sends a death report (%s), even one that never left",
    async (errorCode) => {
      // The sandbox's own `stopped` report owns a death's recovery, and may
      // already have revived the turn onto a fresh boot: a death report
      // landing late would fail that retry. MUTATION-PROOF: re-sending every
      // provably-unsent turn end posts twice here.
      const api = controlPlane([refused()]);
      const { chain } = chainFor(api);
      chain.report({
        kind: "turn.finished",
        sandboxId: "sb-1",
        conversationId: "c-1",
        turnId: "t1",
        status: "failed",
        errorCode,
      });
      await settle(chain);
      expect(api.posts()).toBe(1);
    },
  );

  it("still re-sends an ordinary failure that never left", async () => {
    const failure: RunnerEvent = {
      kind: "turn.finished",
      sandboxId: "sb-1",
      conversationId: "c-1",
      turnId: "t1",
      status: "failed",
      errorCode: "model_provider_error",
    };
    const api = controlPlane([refused()]);
    const { chain } = chainFor(api);
    chain.report(failure);
    await settle(chain);
    expect(api.delivered).toEqual([failure]);
  });

  it("never re-sends transcript events (a re-post could duplicate rows)", async () => {
    const api = controlPlane([refused()]);
    const { chain } = chainFor(api);
    chain.report(events("t1"));
    await settle(chain);
    expect(api.posts()).toBe(1);
    expect(api.delivered).toEqual([]);
  });

  it("a re-send lands behind what was queued before it, never ahead", async () => {
    const api = controlPlane([refused()]);
    const { chain } = chainFor(api);
    chain.report(finished("t1"));
    await chain.drained();
    // The failed close is waiting out its backoff; the next turn's events
    // are queued now, and the re-send re-enters the chain behind them.
    chain.report(events("t2"));
    await settle(chain);
    expect(api.delivered).toEqual([events("t2"), finished("t1")]);
  });

  it("gives up after its budget, leaving the turn to the stall sweep", async () => {
    const api = controlPlane(Array.from({ length: 1_000 }, () => refused()));
    const { chain, warns } = chainFor(api);
    chain.report(finished("t1"));
    await settle(chain);
    // The first post plus the bounded re-sends, then never again.
    expect(api.posts()).toBe(65);
    expect(warns).toContain("gave up re-sending a turn's end");
  });

  it("jitters each re-send under a doubling ceiling", async () => {
    // Full jitter: the wait is a uniform draw under 2s, then 4s, ... With
    // the draw pinned at its top, each wait reaches its whole ceiling.
    vi.spyOn(Math, "random").mockReturnValue(0.999_999);
    const api = controlPlane([refused(), refused()]);
    const { chain } = chainFor(api);
    chain.report(finished("t1"));
    await chain.drained();

    await vi.advanceTimersByTimeAsync(1_990);
    expect(api.posts()).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(api.posts()).toBe(2);

    await vi.advanceTimersByTimeAsync(3_980);
    expect(api.posts()).toBe(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(api.posts()).toBe(3);
    expect(api.delivered).toEqual([finished("t1")]);
  });

  it("a draw of zero re-sends at once", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const api = controlPlane([refused()]);
    const { chain } = chainFor(api);
    chain.report(finished("t1"));
    await chain.drained();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.delivered).toEqual([finished("t1")]);
  });

  it("a turn's end is never dropped by the queue cap; other reports are", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const delivered: RunnerEvent[] = [];
    const warns: string[] = [];
    const chain = createReportChain({
      post: async (batch) => {
        await gate;
        delivered.push(...batch);
      },
      warn: (message) => warns.push(message),
    });
    for (let i = 0; i < 200; i += 1) chain.report(events(`t${i}`));
    chain.report(events("over")); // past the cap: dropped
    chain.report(finished("t0")); // past the cap: still queued
    release();
    await settle(chain);
    expect(delivered).toHaveLength(201);
    expect(delivered.at(-1)?.kind).toBe("turn.finished");
    expect(warns).toEqual(["report queue full; dropping an event"]);
  });

  it("bounds turn ends too: a sandbox flooding them cannot grow the queue past the reserve", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let posts = 0;
    const chain = createReportChain({
      post: async () => {
        await gate;
        posts += 1;
      },
      warn: () => {},
    });
    for (let i = 0; i < 1_000; i += 1) chain.report(finished(`t${i}`));
    release();
    await settle(chain);
    expect(posts).toBe(200 + 64);
  });

  it("one sandbox cannot hold the re-send pool: its own share is capped, others still re-send", async () => {
    // A sandbox can make every one of its turn ends fail provably (a
    // payload the control plane refuses with a 500, every time). Without a
    // per-sandbox share it fills the whole pool and another tenant's lost
    // turn end is never re-sent. MUTATION-PROOF: drop the per-sandbox cap
    // and the victim's close is not delivered.
    const hostile = (turnId: string) => finished(turnId, "sb-hostile");
    const victim = finished("v1", "sb-victim");
    let victimFailures = 1;
    const delivered: RunnerEvent[] = [];
    const warns: string[] = [];
    const chain = createReportChain({
      post: async ([event]) => {
        if (event?.sandboxId === "sb-hostile") {
          throw new ControlPlaneError(500, "x");
        }
        if (victimFailures > 0) {
          victimFailures -= 1;
          throw refused();
        }
        if (event) delivered.push(event);
      },
      warn: (message) => warns.push(message),
    });
    for (let i = 0; i < 100; i += 1) chain.report(hostile(`h${i}`));
    chain.report(victim);
    await settle(chain);
    expect(delivered).toEqual([victim]);
    expect(
      warns.filter((m) => m === "failed to report a turn's end; re-sending it"),
    ).toHaveLength(8 + 1);
  });

  it("caps pending re-sends across the process", async () => {
    const warns: string[] = [];
    const chain = createReportChain({
      post: async () => {
        throw refused();
      },
      warn: (message) => warns.push(message),
    });
    for (let s = 0; s < 20; s += 1) {
      for (let t = 0; t < 8; t += 1) chain.report(finished(`t${t}`, `sb-${s}`));
    }
    await chain.drained();
    expect(
      warns.filter((m) => m === "failed to report a turn's end; re-sending it"),
    ).toHaveLength(64);
    await settle(chain);
  });
});
