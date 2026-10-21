import { describe, expect, it, vi } from "vitest";
import type { WorkItem } from "@onecli/agent-protocol";
import {
  createWsTransport,
  DEFAULT_MAX_ATTEMPTS,
  MAX_OUTBOUND_MESSAGES,
} from "./ws";

/**
 * The WS driver against a fake socket. The point of these tests is that the
 * driver obeys the SAME laws as the stdio driver — one seam, one contract —
 * plus the two properties only a socket has: buffer-until-open and reconnect.
 */

interface FakeSocket extends EventTarget {
  readyState: number;
  sent: string[];
  send(data: string): void;
  open(): void;
  emit(raw: string): void;
  fail(): void;
  close(): void;
  url: string;
}

const createFakeSocket = (url: string): FakeSocket => {
  const target = new EventTarget() as FakeSocket;
  target.url = url;
  target.readyState = 0; // CONNECTING
  target.sent = [];
  target.send = (data: string) => {
    target.sent.push(data);
  };
  target.open = () => {
    target.readyState = WebSocket.OPEN;
    target.dispatchEvent(new Event("open"));
  };
  target.emit = (raw: string) => {
    target.dispatchEvent(new MessageEvent("message", { data: raw }));
  };
  target.fail = () => {
    target.readyState = WebSocket.CLOSED;
    target.dispatchEvent(new Event("close"));
  };
  target.close = () => {
    target.readyState = WebSocket.CLOSED;
    target.dispatchEvent(new Event("close"));
  };
  return target;
};

const setup = (options: { maxAttempts?: number; sandboxId?: string } = {}) => {
  const sockets: FakeSocket[] = [];
  const transport = createWsTransport({
    url: "ws://runner:8484",
    token: "boot-token",
    sandboxId: options.sandboxId ?? "sb-test",
    socketFactory: (url) => {
      const socket = createFakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    minBackoffMs: 1,
    maxBackoffMs: 2,
    maxAttempts: options.maxAttempts ?? Infinity,
  });
  return { transport, sockets };
};

const collect = async (
  iterable: AsyncIterable<WorkItem>,
  count: number,
): Promise<WorkItem[]> => {
  const items: WorkItem[] = [];
  for await (const item of iterable) {
    items.push(item);
    if (items.length === count) break;
  }
  return items;
};

describe("connection", () => {
  it("presents the bootstrap token on the URL", () => {
    const { sockets } = setup();
    expect(sockets[0]?.url).toBe("ws://runner:8484?token=boot-token");
  });

  it("buffers sends until the socket opens, preserving order", () => {
    const { transport, sockets } = setup();
    const socket = sockets[0]!;

    transport.send({ kind: "ready", harness: "jcode" });
    transport.send({
      kind: "turn.result",
      turnId: "t-1",
      conversationId: "cv1",
      status: "done",
    });
    expect(socket.sent).toEqual([]);

    socket.open();

    expect(socket.sent.map((raw) => JSON.parse(raw))).toEqual([
      { kind: "ready", harness: "jcode" },
      {
        kind: "turn.result",
        turnId: "t-1",
        conversationId: "cv1",
        status: "done",
      },
    ]);
  });

  it("reconnects after an unexpected close", async () => {
    const { sockets } = setup();
    sockets[0]!.open();
    sockets[0]!.fail();

    await vi.waitFor(() => expect(sockets.length).toBe(2));
  });

  it("KEEPS THE PROCESS ALIVE while it waits to reconnect", async () => {
    // The reconnect test above passes even when the timer is `unref`'d,
    // because vitest's own event loop keeps the process up. In a sandbox
    // nothing else is running: the socket is gone and the reader is parked on
    // a promise, which does not hold Node open. An unref'd timer there means
    // the process exits — cleanly, code 0 — before the reconnect ever fires,
    // so a runner restart silently kills every sandbox on the host while the
    // control plane still believes they are running.
    //
    // So this asserts the thing that actually matters: after a close, a
    // REF'd timer exists, i.e. the runtime has a reason to stay alive.
    const countTimers = () =>
      process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

    const before = countTimers();
    const { sockets } = setup();
    sockets[0]!.open();
    sockets[0]!.fail();

    expect(countTimers()).toBeGreaterThan(before);
    await vi.waitFor(() => expect(sockets.length).toBe(2));
  });

  it("keeps retrying when a reconnect fails with ONLY an error event", async () => {
    // A socket that never establishes may emit `error` and no `close` at all.
    // Driving the retry solely from `close` therefore stops the chain on the
    // first failed attempt — exactly the attempt that fails while the runner
    // is mid-restart, so the sandbox would die on every runner restart.
    const { sockets } = setup();
    sockets[0]!.open();
    sockets[0]!.fail();
    await vi.waitFor(() => expect(sockets.length).toBe(2));

    // The retry attempt fails to connect: error only, no close.
    sockets[1]!.dispatchEvent(new Event("error"));

    await vi.waitFor(() => expect(sockets.length).toBe(3));
  });

  it("has a FINITE default retry budget", () => {
    // Infinite retry looks safer and is not: a sandbox whose runner is truly
    // gone would dial forever, holding memory and a home volume, and
    // stay invisible to a reconcile that only knows objects labelled by the
    // CURRENT runner. Giving up ends the process, which stops the container —
    // the state an operator can actually see and clean up.
    expect(Number.isFinite(DEFAULT_MAX_ATTEMPTS)).toBe(true);
    // And long enough to outlive a real outage: with the backoff capped at
    // 15s this is roughly a quarter of an hour.
    expect(DEFAULT_MAX_ATTEMPTS).toBeGreaterThanOrEqual(40);
  });

  describe("reconnect delay", () => {
    // A runner copy closes every socket it holds at once when it rolls or
    // stops (hundreds of sandboxes). Without jitter they all redial in the
    // same instant, and keep retrying in lockstep. Equal jitter: each delay
    // is a random point in [half, all] of the exponential step, so the cap
    // is never exceeded (the runner's resume grace is derived from it) and
    // no sandbox redials before half the step (the leaving copy may still be
    // in the balancer's rotation for a moment).
    const delays = (random: () => number, failures: number) => {
      vi.useFakeTimers();
      try {
        const spy = vi.spyOn(globalThis, "setTimeout");
        const sockets: FakeSocket[] = [];
        createWsTransport({
          url: "ws://runner:8484",
          token: "boot-token",
          sandboxId: "sb-test",
          socketFactory: (url) => {
            const socket = createFakeSocket(url);
            sockets.push(socket);
            return socket as unknown as WebSocket;
          },
          minBackoffMs: 500,
          maxBackoffMs: 15_000,
          maxAttempts: Infinity,
          random,
        });
        sockets[0]!.open();
        const seen: number[] = [];
        for (let i = 0; i < failures; i += 1) {
          spy.mockClear();
          sockets[sockets.length - 1]!.fail();
          const call = spy.mock.calls.find(([, ms]) => typeof ms === "number");
          seen.push(Number(call?.[1]));
          vi.runOnlyPendingTimers();
        }
        spy.mockRestore();
        return seen;
      } finally {
        vi.useRealTimers();
      }
    };

    it("stays inside [half, all] of each exponential step, the cap included", () => {
      // MUTATION-PROOF: drop the jitter (low and high runs match), let it
      // exceed the step (high run passes the cap), or start it at zero (low
      // run redials at once).
      // The steps: the minimum twice (the first retry after an open is
      // floored at it), then doubling to the cap.
      const steps = [500, 500, 1000, 2000, 4000, 8000, 15_000, 15_000];
      const low = delays(() => 0, steps.length);
      const high = delays(() => 0.999_999, steps.length);
      expect(low).toEqual(steps.map((step) => step / 2));
      for (const [i, ms] of high.entries()) {
        expect(ms).toBeLessThanOrEqual(steps[i]!);
        expect(ms).toBeGreaterThan(low[i]!);
      }
    });

    it("spreads a fleet that lost its runner copy at the same instant", () => {
      // Fifty sandboxes, one shared outage: their first redials must not
      // land together. MUTATION-PROOF: ignore `random` and every delay is
      // the same.
      let seed = 1;
      const lcg = () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
        return seed / 2 ** 31;
      };
      const firsts = Array.from({ length: 50 }, () => delays(lcg, 1)[0]!);
      expect(new Set(firsts).size).toBeGreaterThan(40);
    });
  });

  it("ignores a superseded socket, so the retry budget cannot be reset", async () => {
    // A late `open` from a socket that has already been replaced would reset
    // `attempts` for a connection nobody uses — defeating the bound whose
    // whole job is to let an orphaned sandbox eventually exit.
    const { sockets } = setup({ maxAttempts: 3 });
    sockets[0]!.fail(); // attempt 1 spent
    await vi.waitFor(() => expect(sockets.length).toBe(2));

    // The dead first socket comes back to life late.
    sockets[0]!.open();
    sockets[1]!.fail(); // attempt 2 spent — only if the reset was ignored
    await vi.waitFor(() => expect(sockets.length).toBe(3));
    sockets[2]!.fail(); // attempt 3 — the budget must now be exhausted

    await vi.waitFor(() => expect(sockets.length).toBe(3));
    expect(sockets).toHaveLength(3);
  });

  it("caps the outbound backlog while the channel is down", async () => {
    // The sandbox keeps working while disconnected, and after a runner
    // restart its single-use token means the retry usually cannot succeed —
    // so an unbounded queue buffers megabytes for the whole budget and then
    // throws it away.
    const { transport, sockets } = setup();
    for (let i = 0; i < MAX_OUTBOUND_MESSAGES + 500; i += 1) {
      transport.send({ kind: "ready", harness: "fake" });
    }
    sockets[0]!.open();

    expect(sockets[0]!.sent.length).toBeLessThanOrEqual(MAX_OUTBOUND_MESSAGES);
  });

  it("drops liveness heartbeats while the channel is down — never buffers them", async () => {
    // A beat that would sit in a dead channel's backlog is stale on arrival,
    // and a long outage's worth of them would flood the runner's report
    // queue on reconnect — racing the very turn.result frames the backlog
    // exists to preserve. The next timer tick re-beats within a minute of
    // the channel coming back; other kinds still buffer.
    const { transport, sockets } = setup();
    transport.send({ kind: "progress", turnId: "t1", conversationId: "cv1" });
    transport.send({ kind: "ready", harness: "fake" });
    sockets[0]!.open();

    const kinds = sockets[0]!.sent.map(
      (raw) => (JSON.parse(raw) as { kind: string }).kind,
    );
    expect(kinds).toContain("ready");
    expect(kinds).not.toContain("progress");

    // And a beat sent while the socket IS open writes through like anything
    // else — the drop is a disconnected-only rule.
    transport.send({ kind: "progress", turnId: "t1", conversationId: "cv1" });
    const after = sockets[0]!.sent.map(
      (raw) => (JSON.parse(raw) as { kind: string }).kind,
    );
    expect(after).toContain("progress");
  });

  it("drops port stream frames while the channel is down", async () => {
    // The runner tears a sandbox's streams down when its channel drops, so a
    // buffered port frame would replay against a stream nobody holds.
    const { transport, sockets } = setup();
    transport.send({ kind: "port.data", streamId: "s1", dataBase64: "AA==" });
    transport.send({ kind: "ready", harness: "fake" });
    sockets[0]!.open();

    const kinds = sockets[0]!.sent.map(
      (raw) => (JSON.parse(raw) as { kind: string }).kind,
    );
    expect(kinds).toContain("ready");
    expect(kinds).not.toContain("port.data");

    transport.send({ kind: "port.data", streamId: "s1", dataBase64: "AA==" });
    const after = sockets[0]!.sent.map(
      (raw) => (JSON.parse(raw) as { kind: string }).kind,
    );
    expect(after).toContain("port.data");
  });

  it("gives up after the attempt limit and ends the stream", async () => {
    const { transport, sockets } = setup({ maxAttempts: 1 });
    sockets[0]!.fail();

    const items: WorkItem[] = [];
    for await (const item of transport.incoming()) items.push(item);
    expect(items).toEqual([]);
  });
});

describe("the shared transport laws", () => {
  it("yields work items in arrival order", async () => {
    const { transport, sockets } = setup();
    const socket = sockets[0]!;
    socket.open();

    const collected = collect(transport.incoming(), 2);
    socket.emit(
      JSON.stringify({
        kind: "turn.deliver",
        turnId: "t-1",
        conversationId: "cv1",
        message: "one",
      }),
    );
    socket.emit(
      JSON.stringify({
        kind: "turn.deliver",
        turnId: "t-2",
        conversationId: "cv1",
        message: "two",
      }),
    );

    expect(await collected).toEqual([
      {
        kind: "turn.deliver",
        turnId: "t-1",
        conversationId: "cv1",
        message: "one",
      },
      {
        kind: "turn.deliver",
        turnId: "t-2",
        conversationId: "cv1",
        message: "two",
      },
    ]);
  });

  it("queues items that arrive before anything is listening", async () => {
    const { transport, sockets } = setup();
    const socket = sockets[0]!;
    socket.open();
    socket.emit(
      JSON.stringify({
        kind: "turn.deliver",
        turnId: "t-early",
        conversationId: "cv1",
        message: "hi",
      }),
    );

    expect(await collect(transport.incoming(), 1)).toEqual([
      {
        kind: "turn.deliver",
        turnId: "t-early",
        conversationId: "cv1",
        message: "hi",
      },
    ]);
  });

  it("DROPS a non-JSON frame instead of throwing", async () => {
    const { transport, sockets } = setup();
    const socket = sockets[0]!;
    socket.open();

    const collected = collect(transport.incoming(), 1);
    socket.emit("}{ not json");
    socket.emit(
      JSON.stringify({
        kind: "turn.deliver",
        turnId: "t-1",
        conversationId: "cv1",
        message: "ok",
      }),
    );

    expect(await collected).toEqual([
      {
        kind: "turn.deliver",
        turnId: "t-1",
        conversationId: "cv1",
        message: "ok",
      },
    ]);
  });

  it("DROPS a frame that is not a valid work item", async () => {
    const { transport, sockets } = setup();
    const socket = sockets[0]!;
    socket.open();

    const collected = collect(transport.incoming(), 1);
    socket.emit(JSON.stringify({ kind: "turn.deliver" }));
    socket.emit(
      JSON.stringify({
        kind: "turn.deliver",
        turnId: "t-2",
        conversationId: "cv1",
        message: "ok",
      }),
    );

    expect(await collected).toEqual([
      {
        kind: "turn.deliver",
        turnId: "t-2",
        conversationId: "cv1",
        message: "ok",
      },
    ]);
  });

  it("yields shutdown and then ENDS the stream", async () => {
    const { transport, sockets } = setup();
    const socket = sockets[0]!;
    socket.open();

    const items: WorkItem[] = [];
    const done = (async () => {
      for await (const item of transport.incoming()) items.push(item);
    })();

    socket.emit(JSON.stringify({ kind: "shutdown" }));
    socket.emit(
      JSON.stringify({
        kind: "turn.deliver",
        turnId: "after",
        conversationId: "cv1",
        message: "no",
      }),
    );

    await done;
    expect(items).toEqual([{ kind: "shutdown" }]);
  });

  it("does not reconnect after a shutdown", async () => {
    const { sockets } = setup();
    const socket = sockets[0]!;
    socket.open();
    socket.emit(JSON.stringify({ kind: "shutdown" }));
    socket.fail();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sockets).toHaveLength(1);
  });

  describe("close", () => {
    it("leaves an already-sent message on the wire and releases the socket", async () => {
      // The last messages before a close are the ones that matter most — the
      // `unhealthy` report and a dying turn's terminal result — so closing
      // must not lose what `send` already handed over.
      const { transport, sockets } = setup();
      const socket = sockets[0]!;
      socket.open();

      transport.send({
        kind: "unhealthy",
        reason: "harness connection closed",
      });
      await transport.close();

      expect(socket.sent.map((raw) => JSON.parse(raw).kind)).toEqual([
        "unhealthy",
      ]);
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    });

    it("ends `incoming()` so the supervisor's loop can finish", async () => {
      // Without this the reader stays parked on a promise forever and the
      // container never exits.
      const { transport, sockets } = setup();
      sockets[0]!.open();

      const reading = (async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _item of transport.incoming()) {
          // nothing arrives; the point is that this loop TERMINATES
        }
      })();

      await transport.close();
      await reading;
    });

    it("does not reconnect after close", async () => {
      const { transport, sockets } = setup();
      sockets[0]!.open();

      await transport.close();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(sockets).toHaveLength(1);
    });
  });
});

/**
 * The resumable channel. Once the runner hands this supervisor a session, the
 * transport (and only the transport: the supervisor loop never sees it)
 * reconnects WITH it, numbers every outbound frame, trims its buffer on the
 * runner's acks, and replays exactly the unacked tail after a gap. Before a
 * session exists the wire is byte-for-byte what it was: a bare bootstrap
 * token and bare frames, so an old runner notices nothing.
 */
describe("resumable session", () => {
  const session = (credential: string, ack = 0) =>
    JSON.stringify({ kind: "session", credential, ack });
  const envelopes = (socket: FakeSocket) =>
    socket.sent.map(
      (raw) => JSON.parse(raw) as { seq?: number; kind?: string },
    );

  it("sends BARE frames and never an envelope until a session is held", () => {
    const { transport, sockets } = setup();
    sockets[0]!.open();
    transport.send({ kind: "ready", harness: "h" });
    expect(envelopes(sockets[0]!)).toEqual([{ kind: "ready", harness: "h" }]);
  });

  it("reconnects with the session, not the spent bootstrap token, and keeps the sandbox id beside it", async () => {
    const { transport, sockets } = setup({ sandboxId: "sb-1" });
    sockets[0]!.open();
    sockets[0]!.emit(session("v1.k1.cred"));
    sockets[0]!.fail();
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    const url = new URL(sockets[1]!.url);
    expect(url.searchParams.get("session")).toBe("v1.k1.cred");
    expect(url.searchParams.get("sandbox")).toBe("sb-1");
    expect(url.searchParams.get("token")).toBeNull();
    void transport;
  });

  it("the session item is consumed by the transport: the supervisor loop never sees it", async () => {
    const { transport, sockets } = setup();
    sockets[0]!.open();
    sockets[0]!.emit(session("v1.k1.cred"));
    sockets[0]!.emit(JSON.stringify({ kind: "shutdown" }));
    const items = await collect(transport.incoming(), 1);
    expect(items).toEqual([{ kind: "shutdown" }]);
  });

  it("numbers every frame once a session is held, monotonically", () => {
    const { transport, sockets } = setup();
    sockets[0]!.open();
    sockets[0]!.emit(session("v1.k1.cred"));
    transport.send({ kind: "ready", harness: "a" });
    transport.send({ kind: "ready", harness: "b" });
    expect(envelopes(sockets[0]!).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("a session handed LATE on the live socket (the cloud order) leaves the bare frames already sent alone and numbers from 1 after it", async () => {
    // On the cloud backend the runner learns the container ref only after the
    // supervisor has connected, so the session arrives mid-socket. What went
    // out bare was applied bare (the runner's passthrough) and must never be
    // replayed or renumbered; from the hand-off on, frames are sequenced and
    // a reconnect replays only those.
    const { transport, sockets } = setup({ sandboxId: "sb-1" });
    sockets[0]!.open();
    transport.send({ kind: "ready", harness: "bare" });
    sockets[0]!.emit(session("v1.k1.late"));
    transport.send({ kind: "ready", harness: "after" });
    expect(envelopes(sockets[0]!)).toEqual([
      { kind: "ready", harness: "bare" },
      { seq: 1, message: { kind: "ready", harness: "after" } },
    ]);

    sockets[0]!.fail();
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    sockets[1]!.open();
    sockets[1]!.emit(session("v1.k1.late", 0));
    expect(envelopes(sockets[1]!)).toEqual([
      { seq: 1, message: { kind: "ready", harness: "after" } },
    ]);
    void transport;
  });

  it("replays exactly the unacked tail after a reconnect, in order, with the same seqs", async () => {
    const { transport, sockets } = setup({ sandboxId: "sb-1" });
    sockets[0]!.open();
    sockets[0]!.emit(session("v1.k1.cred"));
    transport.send({ kind: "ready", harness: "a" }); // seq 1
    transport.send({ kind: "ready", harness: "b" }); // seq 2
    sockets[0]!.emit(JSON.stringify({ kind: "ack", seq: 1 }));
    transport.send({ kind: "ready", harness: "c" }); // seq 3
    sockets[0]!.fail();
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    sockets[1]!.open();
    // The runner's hand-off on reconnect carries its cursor; here it saw 1.
    sockets[1]!.emit(session("v1.k1.cred", 1));
    const replayed = envelopes(sockets[1]!);
    expect(replayed.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("trusts the runner's cursor on reconnect over its own acks: a runner that lost state replays from zero", async () => {
    // A runner that RESTARTED applied nothing it does not remember: its
    // hand-off says ack 0 even though the old process acked 2. Everything
    // unacked by THIS process must be re-sent; the runner dedupes nothing
    // here because it genuinely has nothing.
    const { transport, sockets } = setup({ sandboxId: "sb-1" });
    sockets[0]!.open();
    sockets[0]!.emit(session("v1.k1.cred"));
    transport.send({ kind: "ready", harness: "a" }); // 1
    transport.send({ kind: "ready", harness: "b" }); // 2
    sockets[0]!.emit(JSON.stringify({ kind: "ack", seq: 2 }));
    transport.send({ kind: "ready", harness: "c" }); // 3
    sockets[0]!.fail();
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    sockets[1]!.open();
    sockets[1]!.emit(session("v1.k1.cred", 0));
    // Acked frames are gone from the buffer (that is what an ack means), so
    // only 3 can be replayed; the control plane's history covers 1 and 2.
    expect(envelopes(sockets[1]!).map((e) => e.seq)).toEqual([3]);
  });

  it("replays from the runner's cursor even when it is behind the last in-flight ack", async () => {
    // seq 1..3 sent; the runner acked 3 on the OLD socket; then it restarted
    // and its hand-off says 2 (it persisted nothing past 2). 3 must replay:
    // the local ack is not the truth, the hand-off is.
    const { transport, sockets } = setup({ sandboxId: "sb-1" });
    sockets[0]!.open();
    sockets[0]!.emit(session("v1.k1.cred"));
    transport.send({ kind: "ready", harness: "a" });
    transport.send({ kind: "ready", harness: "b" });
    transport.send({ kind: "ready", harness: "c" });
    sockets[0]!.emit(JSON.stringify({ kind: "ack", seq: 2 }));
    sockets[0]!.fail();
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    sockets[1]!.open();
    sockets[1]!.emit(session("v1.k1.cred", 2));
    expect(envelopes(sockets[1]!).map((e) => e.seq)).toEqual([3]);
    // And a SECOND reconnect replays 3 again if still unacked: the write
    // cursor is per socket, not per process.
    sockets[1]!.fail();
    await vi.waitFor(() => expect(sockets.length).toBe(3));
    sockets[2]!.open();
    sockets[2]!.emit(session("v1.k1.cred", 2));
    expect(envelopes(sockets[2]!).map((e) => e.seq)).toEqual([3]);
  });

  it("keeps presenting its session after a refused reconnect: the bootstrap token is spent and can never help", async () => {
    // A refused dial is what a closing or crashed runner copy answers while
    // the balancer still routes to it, so a supervisor sees refusals on
    // ordinary rolls. The token was used up by the first connect (a session
    // is only ever handed on a connected socket), so falling back to it
    // could only throw the one credential that still works away.
    // Budget: the open resets attempts to 0; two refusals = 2, the limit.
    const { transport, sockets } = setup({ sandboxId: "sb-1", maxAttempts: 2 });
    sockets[0]!.open();
    sockets[0]!.emit(session("v1.k1.cred"));
    sockets[0]!.fail();
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    sockets[1]!.fail(); // refused: closed before it ever opened
    await vi.waitFor(() => expect(sockets.length).toBe(3));
    for (const socket of sockets.slice(1)) {
      const params = new URL(socket.url).searchParams;
      expect(params.get("session")).toBe("v1.k1.cred");
      expect(params.get("sandbox")).toBe("sb-1");
      expect(params.get("token")).toBeNull();
    }
    // The ordinary finite budget still ends a session nobody accepts.
    sockets[2]!.fail();
    const items: WorkItem[] = [];
    for await (const item of transport.incoming()) items.push(item);
    expect(items).toEqual([]);
    expect(sockets).toHaveLength(3);
  });

  it("resumes on the copy that accepts it after refusals, with its unacked tail", async () => {
    const { transport, sockets } = setup({ sandboxId: "sb-1" });
    sockets[0]!.open();
    sockets[0]!.emit(session("v1.k1.cred"));
    transport.send({ kind: "ready", harness: "x" });
    sockets[0]!.fail();
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    sockets[1]!.fail();
    await vi.waitFor(() => expect(sockets.length).toBe(3));
    sockets[2]!.fail();
    await vi.waitFor(() => expect(sockets.length).toBe(4));
    // Another copy takes it, under the same key: the session resumes and
    // the unacked frame replays with its original seq.
    expect(new URL(sockets[3]!.url).searchParams.get("session")).toBe(
      "v1.k1.cred",
    );
    sockets[3]!.open();
    sockets[3]!.emit(session("v1.k1.cred", 0));
    expect(envelopes(sockets[3]!).map((e) => e.seq)).toEqual([1]);
  });

  it("still drops liveness heartbeats while down, session or not", () => {
    const { transport, sockets } = setup();
    sockets[0]!.open();
    sockets[0]!.emit(session("v1.k1.cred"));
    sockets[0]!.fail();
    transport.send({ kind: "progress", turnId: "t", conversationId: "c" });
    transport.send({ kind: "ready", harness: "x" });
    // Only the ready is buffered (it replays); the beat is gone.
    return vi
      .waitFor(() => expect(sockets.length).toBe(2))
      .then(() => {
        sockets[1]!.open();
        sockets[1]!.emit(session("v1.k1.cred", 0));
        expect(envelopes(sockets[1]!).map((e) => e.seq)).toEqual([1]);
      });
  });
});
