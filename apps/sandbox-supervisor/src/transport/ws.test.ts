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

const setup = (options: { maxAttempts?: number } = {}) => {
  const sockets: FakeSocket[] = [];
  const transport = createWsTransport({
    url: "ws://runner:8484",
    token: "boot-token",
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
