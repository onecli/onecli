import { describe, expect, it } from "vitest";
import {
  MAX_RUNNER_EVENTS_PER_POST,
  runnerEventsRequestSchema,
  type RunnerEvent,
} from "@onecli/agent-protocol";
import { ControlPlaneError, createControlPlaneClient } from "./control-plane";

/**
 * The events POST must degrade to MORE requests when a batch outgrows the
 * wire ceiling — never to one 400 that loses the whole report. The batch
 * that makes this real is a reconcile pass over a big fleet: a dead node's
 * worth of corrective `stopped` events lands in a single report() call.
 */
describe("postEvents chunking", () => {
  const event = (n: number): RunnerEvent => ({
    kind: "sandbox.status",
    sandboxId: `sb-${n}`,
    status: "stopped",
  });

  const capturingClient = () => {
    const batches: RunnerEvent[][] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      // Parsed with the REAL wire schema, so an oversized chunk fails here
      // exactly as the control plane would fail it.
      const body = runnerEventsRequestSchema.parse(
        JSON.parse(String(init?.body)),
      );
      batches.push(body.events);
      return new Response(null, { status: 204 });
    };
    const client = createControlPlaneClient({
      baseUrl: "http://control-plane",
      token: "rnr_test",
      fetchImpl,
    });
    return { client, batches };
  };

  it("slices an oversized batch at the ceiling, preserving order", async () => {
    const { client, batches } = capturingClient();
    const events = Array.from(
      { length: MAX_RUNNER_EVENTS_PER_POST + 50 },
      (_, n) => event(n),
    );

    await client.postEvents(events);

    expect(batches.map((batch) => batch.length)).toEqual([
      MAX_RUNNER_EVENTS_PER_POST,
      50,
    ]);
    // Order is what the report chain depends on: flat again, it is the
    // exact input sequence.
    expect(batches.flat()).toEqual(events);
  });

  it("posts nothing for an empty batch (the wire refuses empty events)", async () => {
    const { client, batches } = capturingClient();

    await client.postEvents([]);

    expect(batches).toEqual([]);
  });

  it("posts chunks strictly in sequence — the next waits for the previous", async () => {
    // The server applies events one at a time in arrival order, and
    // order-sensitive traffic rides this path (turn.finished paired with a
    // corrective sandbox.status). MUTATION-PROOF: firing the chunks
    // concurrently (Promise.all over the slices) fails the first expect.
    const sizes: number[] = [];
    let releaseFirst = (): void => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = runnerEventsRequestSchema.parse(
        JSON.parse(String(init?.body)),
      );
      sizes.push(body.events.length);
      if (sizes.length === 1) await firstHeld;
      return new Response(null, { status: 204 });
    };
    const client = createControlPlaneClient({
      baseUrl: "http://control-plane",
      token: "rnr_test",
      fetchImpl,
    });

    const posting = client.postEvents(
      Array.from({ length: MAX_RUNNER_EVENTS_PER_POST + 50 }, (_, n) =>
        event(n),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sizes).toEqual([MAX_RUNNER_EVENTS_PER_POST]);

    releaseFirst();
    await posting;
    expect(sizes).toEqual([MAX_RUNNER_EVENTS_PER_POST, 50]);
  });
});

/**
 * The retry law (control-plane.ts): retried statuses are ONLY the ones where
 * the server provably did not apply the batch AND a retry can plausibly
 * succeed — a 429 throttle can clear, the events route answers 500 only when
 * zero events applied, a 503 deploy window passes. Everything else stays
 * drop-with-warn: timeouts/network/502/504 may have landed (a re-post could
 * duplicate transcript rows — `seq` is assigned server-side at arrival), and
 * a 403 is a WAF verdict that identical bytes cannot outwait (a content match
 * is deterministic; a rate block outlasts the budget and feeds on retries).
 */
describe("postEvents retry law", () => {
  const event = (n: number): RunnerEvent => ({
    kind: "sandbox.status",
    sandboxId: `sb-${n}`,
    status: "stopped",
  });

  /** Answers one scripted status (or rejection) per call; 204 when exhausted. */
  const scriptedClient = (answers: Array<number | "reject">) => {
    const calls: RunnerEvent[][] = [];
    const sleeps: number[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = runnerEventsRequestSchema.parse(
        JSON.parse(String(init?.body)),
      );
      calls.push(body.events);
      const answer = answers.shift() ?? 204;
      if (answer === "reject") throw new TypeError("fetch failed");
      return answer === 204
        ? new Response(null, { status: 204 })
        : new Response("{}", { status: answer });
    };
    const client = createControlPlaneClient({
      baseUrl: "http://control-plane",
      token: "rnr_test",
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
    return { client, calls, sleeps };
  };

  it.each([429, 500, 503])(
    "retries a %i (provably never applied, plausibly clearing) and succeeds",
    async (status) => {
      const { client, calls, sleeps } = scriptedClient([status]);
      await client.postEvents([event(1)]);
      expect(calls).toHaveLength(2);
      expect(sleeps).toEqual([1_000]);
    },
  );

  it("gives up after the attempt budget and rethrows for the caller's warn", async () => {
    const { client, calls, sleeps } = scriptedClient([503, 503, 503, 503]);
    await expect(client.postEvents([event(1)])).rejects.toBeInstanceOf(
      ControlPlaneError,
    );
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([1_000, 4_000, 10_000]);
  });

  it.each([400, 401, 403, 502, 504])(
    "never retries a %i — durable refusals, WAF verdicts, and may-have-landed answers alike",
    async (status) => {
      const { client, calls, sleeps } = scriptedClient([status]);
      await expect(client.postEvents([event(1)])).rejects.toBeInstanceOf(
        ControlPlaneError,
      );
      expect(calls).toHaveLength(1);
      expect(sleeps).toEqual([]);
    },
  );

  it("never retries a transport failure (the batch may have landed)", async () => {
    const { client, calls, sleeps } = scriptedClient(["reject"]);
    await expect(client.postEvents([event(1)])).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("a mid-run retry re-posts the SAME chunk in place, then moves on", async () => {
    const { client, calls } = scriptedClient([204, 500]);
    const events = Array.from(
      { length: MAX_RUNNER_EVENTS_PER_POST + 50 },
      (_, n) => event(n),
    );
    await client.postEvents(events);
    expect(calls.map((batch) => batch.length)).toEqual([
      MAX_RUNNER_EVENTS_PER_POST,
      50,
      50,
    ]);
    // The retried chunk is identical to its failed attempt — a re-post,
    // never a re-slice, so arrival order (which decides `seq`) holds.
    expect(calls[2]).toEqual(calls[1]);
  });
});
