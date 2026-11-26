import {
  createServer as createHttpServer,
  request,
  type Server,
} from "node:http";
import {
  connect,
  createServer as createTcpServer,
  type AddressInfo,
  type Socket,
} from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  PORT_CHUNK_RAW_BYTES,
  PORT_STREAM_WINDOW_BYTES,
  supervisorMessageSchema,
  workItemSchema,
  type SupervisorMessage,
  type WorkItem,
} from "@onecli/agent-protocol";
import { createPortHub, isPortMessage, PortOpenError } from "./port-hub";

/**
 * Runner PortHub ⇄ (JSON + schema validation, exactly what the ws hop does)
 * ⇄ a minimal in-file guest dialer that speaks the SAME wire contract as the
 * supervisor (it enforces the window and acks on write) ⇄ a real HTTP server.
 * The real supervisor half has its own suite (sandbox-supervisor
 * port-streams.test.ts); the two halves meet end to end in a live sandbox.
 */

/** Wire-faithful stand-in for the supervisor's port-streams. */
const createGuestDialer = (send: (m: SupervisorMessage) => void) => {
  let allowed = new Set<number>();
  type St = {
    s: Socket;
    credit: number;
    opened: boolean;
    parked: Buffer;
    endPending: boolean;
  };
  const socks = new Map<string, St>();
  const pump = (streamId: string, st: St) => {
    while (st.parked.length > 0 && st.credit > 0) {
      const n = Math.min(PORT_CHUNK_RAW_BYTES, st.credit, st.parked.length);
      st.credit -= n;
      send({
        kind: "port.data",
        streamId,
        dataBase64: st.parked.subarray(0, n).toString("base64"),
      });
      st.parked = st.parked.subarray(n);
    }
    if (st.parked.length > 0 || st.credit <= 0) st.s.pause();
    else st.s.resume();
    if (st.parked.length === 0 && st.endPending) {
      st.endPending = false;
      send({ kind: "port.close", streamId, mode: "end" });
    }
  };
  return {
    handle(item: WorkItem) {
      switch (item.kind) {
        case "ports.allow":
          allowed = new Set(item.ports);
          return;
        case "port.open": {
          if (!allowed.has(item.port))
            return send({
              kind: "port.error",
              streamId: item.streamId,
              code: "not_allowed",
            });
          const s = connect({
            host: "127.0.0.1",
            port: item.port,
            allowHalfOpen: true,
          });
          const st: St = {
            s,
            credit: PORT_STREAM_WINDOW_BYTES,
            opened: false,
            parked: Buffer.alloc(0),
            endPending: false,
          };
          socks.set(item.streamId, st);
          s.on("connect", () => {
            st.opened = true;
            send({ kind: "port.opened", streamId: item.streamId });
          });
          s.on("error", (e: NodeJS.ErrnoException) => {
            if (!st.opened)
              send({
                kind: "port.error",
                streamId: item.streamId,
                code: e.code === "ECONNREFUSED" ? "not_listening" : "failed",
              });
            socks.delete(item.streamId);
          });
          s.on("data", (c: Buffer) => {
            st.parked = Buffer.concat([st.parked, c]);
            pump(item.streamId, st);
          });
          s.on("end", () => {
            st.endPending = true;
            pump(item.streamId, st);
          });
          return;
        }
        case "port.data": {
          const st = socks.get(item.streamId);
          const b = Buffer.from(item.dataBase64, "base64");
          st?.s.write(b, () =>
            send({
              kind: "port.ack",
              streamId: item.streamId,
              bytes: b.length,
            }),
          );
          return;
        }
        case "port.ack": {
          const st = socks.get(item.streamId);
          if (!st) return;
          st.credit = Math.min(
            PORT_STREAM_WINDOW_BYTES,
            st.credit + item.bytes,
          );
          pump(item.streamId, st);
          return;
        }
        case "port.close": {
          const st = socks.get(item.streamId);
          if (item.mode === "end") st?.s.end();
          else st?.s.destroy();
          return;
        }
        default:
          return;
      }
    },
    close() {
      for (const { s } of socks.values()) s.destroy();
    },
  };
};

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const wire = (sandboxId = "sbx-1", opts: { dropSupervisor?: boolean } = {}) => {
  let supervisorHandle: (item: WorkItem) => void = () => undefined;
  const hub = createPortHub({
    sendToSandbox: (id, item) => {
      if (id !== sandboxId) return false;
      // The ws hop: serialize, parse, validate — frames must survive it.
      const parsed = workItemSchema.parse(JSON.parse(JSON.stringify(item)));
      if (!opts.dropSupervisor) setImmediate(() => supervisorHandle(parsed));
      return true;
    },
    openTimeoutMs: 500,
  });
  const ps = createGuestDialer((m: SupervisorMessage) => {
    const parsed = supervisorMessageSchema.parse(JSON.parse(JSON.stringify(m)));
    if (isPortMessage(parsed))
      setImmediate(() => hub.handle(sandboxId, parsed));
  });
  supervisorHandle = (item) => ps.handle(item);
  closers.push(() => ps.close());
  return { hub, ps };
};

const httpServer = (handler: Parameters<typeof createHttpServer>[1]) =>
  new Promise<number>((resolve) => {
    const srv: Server = createHttpServer(handler);
    closers.push(() => new Promise<void>((r) => srv.close(() => r())));
    srv.listen(0, "127.0.0.1", () =>
      resolve((srv.address() as AddressInfo).port),
    );
  });

/** Expose the hub stream as a local TCP port so a real HTTP client can use it
 * — the relay's job in production, in miniature. */
const bridge = (
  hub: ReturnType<typeof createPortHub>,
  sandboxId: string,
  guestPort: number,
) =>
  new Promise<number>((resolve) => {
    const srv = createTcpServer(async (client) => {
      try {
        const upstream = await hub.open(sandboxId, guestPort);
        client.pipe(upstream).pipe(client);
        upstream.on("error", () => client.destroy());
        client.on("error", () => upstream.destroy());
      } catch {
        client.destroy();
      }
    });
    closers.push(() => new Promise<void>((r) => srv.close(() => r())));
    srv.listen(0, "127.0.0.1", () =>
      resolve((srv.address() as AddressInfo).port),
    );
  });

const get = (port: number, path: string, body?: Buffer) =>
  new Promise<{
    status: number;
    body: Buffer;
    headers: Record<string, unknown>;
  }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: body ? "POST" : "GET",
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });

describe("port hub ⇄ supervisor streams (end to end)", () => {
  it("serves a real HTTP request through both halves", async () => {
    const guest = await httpServer((req, res) => {
      res.setHeader("x-seen-host", req.headers.host ?? "");
      res.end(`hello from ${req.url}`);
    });
    const { hub } = wire();
    hub.setAllowed("sbx-1", [guest]);
    const local = await bridge(hub, "sbx-1", guest);
    const r = await get(local, "/Main-product/SWDEMO10001");
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe("hello from /Main-product/SWDEMO10001");
  });

  it("moves multi-window bodies intact in both directions (flow control)", async () => {
    const big = Buffer.alloc(PORT_STREAM_WINDOW_BYTES * 5 + 12345);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    const guest = await httpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const got = Buffer.concat(chunks);
        res.setHeader("x-upload-ok", String(got.equals(big)));
        res.end(big);
      });
    });
    const { hub } = wire();
    hub.setAllowed("sbx-1", [guest]);
    const local = await bridge(hub, "sbx-1", guest);
    const r = await get(local, "/upload", big);
    expect(r.headers["x-upload-ok"]).toBe("true");
    expect(r.body.equals(big)).toBe(true);
    expect(hub.activeCount()).toBeLessThanOrEqual(1);
  });

  it("serves many concurrent requests", async () => {
    const guest = await httpServer((req, res) => res.end(req.url));
    const { hub } = wire();
    hub.setAllowed("sbx-1", [guest]);
    const local = await bridge(hub, "sbx-1", guest);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => get(local, `/r${i}`)),
    );
    expect(results.map((r) => r.body.toString())).toEqual(
      Array.from({ length: 20 }, (_, i) => `/r${i}`),
    );
  });

  it("maps refusals to typed errors", async () => {
    const guest = await httpServer((_req, res) => res.end("x"));
    const { hub } = wire();
    await expect(hub.open("sbx-1", guest)).rejects.toMatchObject({
      code: "not_allowed",
    });
    hub.setAllowed("sbx-1", [1]);
    await expect(hub.open("sbx-1", 1)).rejects.toMatchObject({
      code: "not_listening",
    });
    await expect(hub.open("other-sandbox", guest)).rejects.toMatchObject({
      code: "no_sandbox",
    });
  });

  it("times out an open the supervisor never answers (old image)", async () => {
    const { hub } = wire("sbx-1", { dropSupervisor: true });
    const err = await hub.open("sbx-1", 8080).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortOpenError);
    expect((err as PortOpenError).code).toBe("timeout");
    expect(hub.activeCount()).toBe(0);
  });

  it("ignores frames for a stream another sandbox owns", async () => {
    const guest = await httpServer((_req, res) => res.end("x"));
    const { hub } = wire();
    hub.setAllowed("sbx-1", [guest]);
    const p = hub.open("sbx-1", guest);
    // A forged answer from a different authenticated channel is dropped.
    hub.handle("sbx-evil", {
      kind: "port.error",
      streamId: "whatever",
      code: "failed",
    });
    const d = await p;
    expect(d).toBeTruthy();
    d.destroy();
  });

  // A malicious supervisor (same uid as agent code) must never be able to
  // crash the shared runner. Before the fix, `port.close abort` ahead of (or
  // in the same tick as) `port.opened` emitted 'error' on a duplex nobody
  // had subscribed to, an uncaught exception that exited the runner.
  const forgedHub = (frames: (streamId: string) => WorkItem[]) => {
    const hub: ReturnType<typeof createPortHub> = createPortHub({
      sendToSandbox: (_id, item) => {
        if (item.kind === "port.open") {
          const id = item.streamId;
          setImmediate(() => {
            for (const f of frames(id)) hub.handle("sbx-1", f as never);
          });
        }
        return true;
      },
      openTimeoutMs: 500,
    });
    hub.setAllowed("sbx-1", [8080]);
    return hub;
  };

  it("survives a forged close before the stream was opened", async () => {
    const hub = forgedHub((streamId) => [
      { kind: "port.close", streamId, mode: "abort" } as never,
    ]);
    const err = await hub.open("sbx-1", 8080).catch((e: unknown) => e);
    expect((err as PortOpenError).code).toBe("failed");
    await new Promise((r) => setTimeout(r, 20));
    expect(hub.activeCount()).toBe(0);
  });

  it("survives opened + abort in the same tick (no unhandled 'error')", async () => {
    const hub = forgedHub((streamId) => [
      { kind: "port.opened", streamId } as never,
      { kind: "port.close", streamId, mode: "abort" } as never,
    ]);
    const d = await hub.open("sbx-1", 8080);
    await new Promise((r) => setTimeout(r, 20));
    expect(d.destroyed).toBe(true);
    expect(hub.activeCount()).toBe(0);
  });

  it("cuts a stream whose guest ignores credit (no unbounded buffering in the runner)", async () => {
    // The supervisor shares a uid with agent code: a guest that keeps
    // sending past the granted window must not grow the runner's heap.
    // MUTATION-PROOF: drop the window check in deliver() and this stream
    // stays open with > one window buffered.
    const guest = await httpServer((_req, res) => res.end("x"));
    let streamId = "";
    let accept: (item: WorkItem) => void = () => undefined;
    const hub = createPortHub({
      sendToSandbox: (_id, item) => {
        if (item.kind === "port.open") {
          streamId = item.streamId;
          setImmediate(() => accept(item));
        }
        return true;
      },
      openTimeoutMs: 500,
    });
    accept = () => hub.handle("sbx-1", { kind: "port.opened", streamId });
    hub.setAllowed("sbx-1", [guest]);
    const d = await hub.open("sbx-1", guest);
    let error: Error | undefined;
    d.on("error", (e: Error) => {
      error = e;
    });
    d.pause(); // a slow viewer: nothing is read, so nothing is acked
    const dataBase64 = Buffer.alloc(PORT_CHUNK_RAW_BYTES, 1).toString("base64");
    for (
      let sent = 0;
      sent <= 2 * PORT_STREAM_WINDOW_BYTES;
      sent += PORT_CHUNK_RAW_BYTES
    ) {
      hub.handle("sbx-1", { kind: "port.data", streamId, dataBase64 });
    }
    expect(d.destroyed).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(error?.message ?? "").toMatch(/window/);
    expect(hub.activeCount()).toBe(0);
  });

  it("keeps an honest stream open at its worst case: a full readable buffer plus one full credit window", async () => {
    // Acks fire as bytes enter the readable buffer, so an honest guest can
    // legitimately land highWaterMark (acked) + one window (new credit).
    // MUTATION-PROOF: drop readableHighWaterMark from the cutoff and this
    // honest stream is cut.
    const guest = await httpServer((_req, res) => res.end("x"));
    let streamId = "";
    let accept: () => void = () => undefined;
    const hub = createPortHub({
      sendToSandbox: (_id, item) => {
        if (item.kind === "port.open") {
          streamId = item.streamId;
          setImmediate(() => accept());
        }
        return true;
      },
      openTimeoutMs: 500,
    });
    accept = () => hub.handle("sbx-1", { kind: "port.opened", streamId });
    hub.setAllowed("sbx-1", [guest]);
    const d = await hub.open("sbx-1", guest);
    d.on("error", () => undefined);
    d.pause();
    const honestTotal = d.readableHighWaterMark + PORT_STREAM_WINDOW_BYTES;
    for (let sent = 0; sent < honestTotal; ) {
      const n = Math.min(PORT_CHUNK_RAW_BYTES, honestTotal - sent);
      hub.handle("sbx-1", {
        kind: "port.data",
        streamId,
        dataBase64: Buffer.alloc(n, 1).toString("base64"),
      });
      sent += n;
    }
    expect(d.destroyed).toBe(false);
    d.destroy();
  });

  it("sandboxGone rejects pending opens and kills live streams", async () => {
    const { hub } = wire("sbx-1", { dropSupervisor: true });
    const p = hub.open("sbx-1", 8080);
    hub.sandboxGone("sbx-1");
    await expect(p).rejects.toMatchObject({ code: "no_sandbox" });
    expect(hub.activeCount()).toBe(0);
  });
});
