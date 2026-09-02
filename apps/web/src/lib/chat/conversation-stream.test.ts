import { describe, expect, it } from "vitest";
import type { TurnEvent } from "@/lib/api/types";
import {
  isFatalStatus,
  reconnectDelayMs,
  runConversationStream,
  type StreamFatalError,
  type StreamStatus,
} from "./conversation-stream";

const encoder = new TextEncoder();

const frame = (seq: number): string =>
  `id: ${seq}\nevent: transcript\ndata: ${JSON.stringify({
    seq,
    turnId: "t1",
    type: "text.delta",
    payload: { type: "text.delta", text: `d${seq}` },
  })}\n\n`;

/** An SSE Response that enqueues each chunk as its own read, then closes. */
const sseResponse = (chunks: string[]): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

/** An SSE Response that never produces a read until the signal aborts it. */
const hangingSseResponse = (signal: AbortSignal): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener(
          "abort",
          () => controller.error(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

interface Recorded {
  statuses: { status: StreamStatus; error?: StreamFatalError }[];
  batches: TurnEvent[][];
  paths: string[];
  delays: number[];
}

/** Run the engine against scripted responses with instant sleeps. */
const run = (
  respond: (call: number, signal: AbortSignal) => Response | Error,
  options: {
    getCursor?: () => number;
    now?: () => number;
    readLivenessMs?: number;
  } = {},
) => {
  const recorded: Recorded = {
    statuses: [],
    batches: [],
    paths: [],
    delays: [],
  };
  const controller = new AbortController();
  const done = runConversationStream(
    "c1",
    {
      fetchStream: (path, signal) => {
        recorded.paths.push(path);
        const result = respond(recorded.paths.length, signal);
        return result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve(result);
      },
      getCursor: options.getCursor ?? (() => 0),
      delayMs: (attempt) => {
        recorded.delays.push(attempt);
        return 0;
      },
      sleep: () => Promise.resolve(),
      now: options.now,
      readLivenessMs: options.readLivenessMs,
    },
    {
      onEvents: (incoming) => recorded.batches.push(incoming),
      onStatus: (status, error) =>
        recorded.statuses.push({ status, ...(error && { error }) }),
    },
    controller.signal,
  );
  return { recorded, controller, done };
};

describe("runConversationStream", () => {
  it("streams history then tail: one onEvents per read, in order", async () => {
    const { recorded, controller, done } = run((call, signal) =>
      call === 1
        ? sseResponse([frame(1) + frame(2), frame(3)])
        : hangingSseResponse(signal),
    );
    // The first connection closes after its chunks; the second hangs.
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await done;

    expect(recorded.batches.map((b) => b.map((e) => e.seq))).toEqual([
      [1, 2],
      [3],
    ]);
    expect(recorded.statuses.map((s) => s.status)).toEqual([
      "connecting",
      "streaming",
      "reconnecting",
      "streaming",
    ]);
  });

  it("resumes with ?since=<cursor> and connects bare at cursor 0", async () => {
    // Track the cursor the way the hook does: highest seq delivered so far —
    // getCursor must be read at RECONNECT time, not connect time.
    let held = 0;
    const paths: string[] = [];
    const controller = new AbortController();
    const done = runConversationStream(
      "c1",
      {
        fetchStream: (path, signal) => {
          paths.push(path);
          return Promise.resolve(
            paths.length === 1
              ? sseResponse([frame(41)])
              : hangingSseResponse(signal),
          );
        },
        getCursor: () => held,
        delayMs: () => 0,
        sleep: () => Promise.resolve(),
      },
      {
        onEvents: (incoming) => {
          held = Math.max(held, ...incoming.map((e) => e.seq));
        },
        onStatus: () => {},
      },
      controller.signal,
    );
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await done;

    expect(paths[0]).toBe("/v1/conversations/c1/stream");
    expect(paths[1]).toBe("/v1/conversations/c1/stream?since=41");
  });

  it("encodes the conversation id in the stream path", async () => {
    // The id arrives DECODED from the route — "../x" must not URL-normalize
    // the authenticated request onto another /v1 endpoint.
    const paths: string[] = [];
    const controller = new AbortController();
    await runConversationStream(
      "../runners",
      {
        fetchStream: (path) => {
          paths.push(path);
          return Promise.resolve(new Response(null, { status: 404 }));
        },
        getCursor: () => 0,
        delayMs: () => 0,
        sleep: () => Promise.resolve(),
      },
      { onEvents: () => {}, onStatus: () => {} },
      controller.signal,
    );
    expect(paths[0]).toBe("/v1/conversations/..%2Frunners/stream");
  });

  it("stops for good on a fatal refusal, with exactly one fetch", async () => {
    const { recorded, done } = run(() => new Response(null, { status: 404 }));
    await done;

    expect(recorded.paths).toHaveLength(1);
    expect(recorded.statuses.at(-1)).toEqual({
      status: "error",
      error: { httpStatus: 404, message: "Stream refused with 404" },
    });
  });

  it("retries a transient refusal, then streams", async () => {
    const { recorded, controller, done } = run((call, signal) =>
      call === 1
        ? new Response(null, { status: 503 })
        : hangingSseResponse(signal),
    );
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await done;

    expect(recorded.paths).toHaveLength(2);
    expect(recorded.delays).toEqual([1]);
    // Status emits are deduped, so the retry doesn't repeat "connecting".
    expect(recorded.statuses.map((s) => s.status)).toEqual([
      "connecting",
      "streaming",
    ]);
  });

  it("retries a 401 — a transient token-refresh failure must not kill a live thread", async () => {
    const { recorded, controller, done } = run((call, signal) =>
      call === 1
        ? new Response(null, { status: 401 })
        : hangingSseResponse(signal),
    );
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await done;

    expect(recorded.paths).toHaveLength(2);
    expect(recorded.statuses.at(-1)?.status).toBe("streaming");
  });

  it("reconnects when the stream goes silent past the liveness window", async () => {
    // The server heartbeats every 15s; a dead TCP path never errors — the
    // engine must cut a silent read itself instead of hanging forever.
    const { recorded, controller, done } = run(
      (call, signal) => hangingSseResponse(signal),
      { readLivenessMs: 20 },
    );
    await new Promise((r) => setTimeout(r, 120));
    controller.abort();
    await done;

    expect(recorded.paths.length).toBeGreaterThanOrEqual(2);
    expect(recorded.statuses.map((s) => s.status)).toContain("reconnecting");
  });

  it("retries a network error the same way", async () => {
    const { recorded, controller, done } = run((call, signal) =>
      call === 1 ? new Error("boom") : hangingSseResponse(signal),
    );
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await done;
    expect(recorded.paths).toHaveLength(2);
    expect(recorded.statuses.at(-1)?.status).toBe("streaming");
  });

  it("treats a non-SSE 200 as a failed attempt, never parsing it", async () => {
    const { recorded, controller, done } = run((call, signal) =>
      call === 1
        ? new Response("<html>login</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          })
        : hangingSseResponse(signal),
    );
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await done;

    expect(recorded.batches).toEqual([]);
    expect(recorded.delays).toEqual([1]);
    expect(recorded.paths).toHaveLength(2);
  });

  it("goes silent on abort during a pending read — no late callbacks", async () => {
    const { recorded, controller, done } = run((_call, signal) =>
      hangingSseResponse(signal),
    );
    await new Promise((r) => setTimeout(r, 10));
    const before = recorded.statuses.length;
    controller.abort();
    await done;

    expect(recorded.statuses).toHaveLength(before); // nothing after abort
    expect(recorded.batches).toEqual([]);
    expect(recorded.paths).toHaveLength(1);
  });

  it("resolves promptly when aborted during the real backoff sleep", async () => {
    // No injected sleep: exercises defaultSleep's abort-awareness.
    const recorded: string[] = [];
    const controller = new AbortController();
    const done = runConversationStream(
      "c1",
      {
        fetchStream: (path) => {
          recorded.push(path);
          return Promise.reject(new Error("down"));
        },
        getCursor: () => 0,
        delayMs: () => 60_000,
      },
      { onEvents: () => {}, onStatus: () => {} },
      controller.signal,
    );
    await new Promise((r) => setTimeout(r, 20)); // engine is now sleeping
    const started = Date.now();
    controller.abort();
    await done;

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(recorded).toHaveLength(1);
  });

  it("resets the backoff after a healthy connection, not after a brief one", async () => {
    // now() is called only in phase 2: first at the healthy connection's open
    // (0), then ever after at 15_000 — so that connection lived ≥10s and the
    // next (empty) one lived 0ms.
    let nowCalls = 0;
    const { recorded, controller, done } = run(
      (call, signal) => {
        if (call === 1) return new Response(null, { status: 503 });
        if (call === 2) return sseResponse([frame(1)]); // healthy: bytes + 15s
        if (call === 3) return sseResponse([]); // brief: closes with no bytes
        return hangingSseResponse(signal);
      },
      { now: () => (nowCalls++ === 0 ? 0 : 15_000) },
    );
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await done;

    // 503 → attempt 1; healthy cut → RESET to 1; empty connection → 2.
    // Without the reset this reads [1, 2, 3].
    expect(recorded.delays).toEqual([1, 1, 2]);
  });

  it("delivers a frame split across two reads exactly once, on the second", async () => {
    const whole = frame(9);
    const splitAt = Math.floor(whole.length / 2);
    const { recorded, controller, done } = run((call, signal) =>
      call === 1
        ? sseResponse([whole.slice(0, splitAt), whole.slice(splitAt)])
        : hangingSseResponse(signal),
    );
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await done;

    expect(recorded.batches.map((b) => b.map((e) => e.seq))).toEqual([[9]]);
  });
});

describe("isFatalStatus", () => {
  it("stops on 4xx except the retryable trio", () => {
    expect(isFatalStatus(403)).toBe(true);
    expect(isFatalStatus(404)).toBe(true);
    // 401 is retryable: on cloud, a transient token-refresh failure sends a
    // request with no Authorization header at all.
    expect(isFatalStatus(401)).toBe(false);
    expect(isFatalStatus(408)).toBe(false);
    expect(isFatalStatus(429)).toBe(false);
    expect(isFatalStatus(500)).toBe(false);
    expect(isFatalStatus(503)).toBe(false);
  });
});

describe("reconnectDelayMs", () => {
  it("doubles from 500ms to a 30s cap, within the jitter band", () => {
    for (const [attempt, base] of [
      [1, 500],
      [2, 1_000],
      [5, 8_000],
      [7, 30_000],
      [12, 30_000],
    ] as const) {
      const delay = reconnectDelayMs(attempt);
      expect(delay).toBeGreaterThanOrEqual(base * 0.75);
      expect(delay).toBeLessThanOrEqual(base * 1.25);
    }
  });
});
