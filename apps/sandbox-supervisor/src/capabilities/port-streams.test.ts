import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  PORT_CHUNK_RAW_BYTES,
  PORT_STREAM_WINDOW_BYTES,
  type SupervisorMessage,
} from "@onecli/agent-protocol";
import {
  createPortStreams,
  reservedGuestPorts,
  type PortStreams,
} from "./port-streams";

/**
 * Real sockets on loopback, no mocks: the module's whole job is to be a
 * faithful byte pipe with fences, so the tests drive real TCP servers.
 */

const servers: Server[] = [];
const serverSockets: import("node:net").Socket[] = [];
const streamsList: PortStreams[] = [];

const listen = (handler: (sock: import("node:net").Socket) => void) =>
  new Promise<number>((resolve) => {
    const srv = createServer({ allowHalfOpen: true }, (sock) => {
      serverSockets.push(sock);
      handler(sock);
    });
    servers.push(srv);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

const freePort = async () => {
  const port = await listen(() => undefined);
  const srv = servers.pop()!;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
};

const harness = (reservedPorts?: Set<number>, maxStreams?: number) => {
  const sent: SupervisorMessage[] = [];
  const waiters: Array<() => void> = [];
  const ps = createPortStreams({
    send: (m) => {
      sent.push(m);
      waiters.splice(0).forEach((w) => w());
    },
    reservedPorts,
    maxStreams,
  });
  streamsList.push(ps);
  const until = async (pred: () => boolean, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline)
        throw new Error(
          `timeout; sent=${JSON.stringify(sent.map((m) => m.kind))}`,
        );
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 20);
      });
    }
  };
  const of = <K extends SupervisorMessage["kind"]>(
    kind: K,
    streamId?: string,
  ) =>
    sent.filter(
      (m): m is Extract<SupervisorMessage, { kind: K }> =>
        m.kind === kind &&
        (!streamId || ("streamId" in m && m.streamId === streamId)),
    );
  const bytesOut = (streamId: string) =>
    Buffer.concat(
      of("port.data", streamId).map((m) => Buffer.from(m.dataBase64, "base64")),
    );
  return { ps, sent, until, of, bytesOut };
};

afterEach(async () => {
  streamsList.splice(0).forEach((p) => p.close());
  serverSockets.splice(0).forEach((s) => s.destroy());
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

describe("port streams", () => {
  it("fails closed: nothing is dialable before ports.allow", async () => {
    const port = await listen((s) => s.end());
    const h = harness();
    h.ps.handle({ kind: "port.open", streamId: "a", port });
    expect(h.of("port.error", "a")[0]?.code).toBe("not_allowed");
  });

  it("refuses reserved ports even when allowed", async () => {
    const port = await listen((s) => s.end());
    const h = harness(new Set([port]));
    h.ps.handle({ kind: "ports.allow", ports: [port] });
    h.ps.handle({ kind: "port.open", streamId: "a", port });
    expect(h.of("port.error", "a")[0]?.code).toBe("not_allowed");
  });

  it("reports not_listening for a closed port", async () => {
    const port = await freePort();
    const h = harness();
    h.ps.handle({ kind: "ports.allow", ports: [port] });
    h.ps.handle({ kind: "port.open", streamId: "a", port });
    await h.until(() => h.of("port.error", "a").length > 0);
    expect(h.of("port.error", "a")[0]?.code).toBe("not_listening");
    expect(h.ps.activeCount()).toBe(0);
  });

  it("round-trips an HTTP-style exchange with half-close", async () => {
    // Server reads the full request (until client FIN), THEN answers — the
    // shape that breaks if half-close tears the stream down early.
    const port = await listen((sock) => {
      const chunks: Buffer[] = [];
      sock.on("data", (c) => chunks.push(c));
      sock.on("end", () => {
        sock.end(`echo:${Buffer.concat(chunks).toString()}`);
      });
    });
    const h = harness();
    h.ps.handle({ kind: "ports.allow", ports: [port] });
    h.ps.handle({ kind: "port.open", streamId: "s1", port });
    await h.until(() => h.of("port.opened", "s1").length === 1);
    h.ps.handle({
      kind: "port.data",
      streamId: "s1",
      dataBase64: Buffer.from("GET / HTTP/1.1\r\n\r\n").toString("base64"),
    });
    h.ps.handle({ kind: "port.close", streamId: "s1", mode: "end" });
    await h.until(() => h.of("port.close", "s1").length > 0);
    expect(h.bytesOut("s1").toString()).toBe("echo:GET / HTTP/1.1\r\n\r\n");
    expect(h.of("port.close", "s1").map((m) => m.mode)).toEqual(["end"]);
    await h.until(() => h.ps.activeCount() === 0);
    expect(h.of("port.opened", "s1")).toHaveLength(1);
  });

  it("chunks large guest payloads to the wire bound and respects the window", async () => {
    const total = PORT_STREAM_WINDOW_BYTES * 3;
    const payload = Buffer.alloc(total, 0x61);
    const port = await listen((sock) => sock.end(payload));
    const h = harness();
    h.ps.handle({ kind: "ports.allow", ports: [port] });
    h.ps.handle({ kind: "port.open", streamId: "big", port });
    // Without acks it must stall at ~one window (plus at most one socket read).
    await h.until(() => h.bytesOut("big").length >= PORT_STREAM_WINDOW_BYTES);
    await new Promise((r) => setTimeout(r, 150));
    const stalled = h.bytesOut("big").length;
    expect(stalled).toBeLessThan(total);
    expect(stalled).toBeLessThanOrEqual(PORT_STREAM_WINDOW_BYTES + 128 * 1024);
    for (const m of h.of("port.data", "big")) {
      expect(Buffer.from(m.dataBase64, "base64").length).toBeLessThanOrEqual(
        PORT_CHUNK_RAW_BYTES,
      );
    }
    // Granting credit drains the rest.
    let granted = 0;
    while (h.bytesOut("big").length < total) {
      const outstanding = h.bytesOut("big").length - granted;
      if (outstanding > 0) {
        const g = Math.min(outstanding, PORT_STREAM_WINDOW_BYTES);
        granted += g;
        h.ps.handle({ kind: "port.ack", streamId: "big", bytes: g });
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.bytesOut("big").equals(payload)).toBe(true);
  });

  it("acks inbound bytes so the runner's window refills", async () => {
    const port = await listen((sock) => sock.resume());
    const h = harness();
    h.ps.handle({ kind: "ports.allow", ports: [port] });
    h.ps.handle({ kind: "port.open", streamId: "in", port });
    await h.until(() => h.of("port.opened", "in").length === 1);
    h.ps.handle({
      kind: "port.data",
      streamId: "in",
      dataBase64: Buffer.from("hello").toString("base64"),
    });
    await h.until(() => h.of("port.ack", "in").length > 0);
    expect(h.of("port.ack", "in").reduce((n, m) => n + m.bytes, 0)).toBe(5);
  });

  it("revoking the allowlist kills live streams", async () => {
    const port = await listen(() => undefined);
    const h = harness();
    h.ps.handle({ kind: "ports.allow", ports: [port] });
    h.ps.handle({ kind: "port.open", streamId: "r", port });
    await h.until(() => h.of("port.opened", "r").length === 1);
    h.ps.handle({ kind: "ports.allow", ports: [] });
    expect(h.of("port.close", "r").map((m) => m.mode)).toEqual(["abort"]);
    expect(h.ps.activeCount()).toBe(0);
    h.ps.handle({ kind: "port.open", streamId: "r2", port });
    expect(h.of("port.error", "r2")[0]?.code).toBe("not_allowed");
  });

  it("enforces the stream cap and duplicate ids", async () => {
    const port = await listen(() => undefined);
    const h = harness(undefined, 2);
    h.ps.handle({ kind: "ports.allow", ports: [port] });
    h.ps.handle({ kind: "port.open", streamId: "1", port });
    h.ps.handle({ kind: "port.open", streamId: "1", port });
    h.ps.handle({ kind: "port.open", streamId: "2", port });
    h.ps.handle({ kind: "port.open", streamId: "3", port });
    expect(h.of("port.error", "1")[0]?.code).toBe("duplicate");
    expect(h.of("port.error", "3")[0]?.code).toBe("limit");
  });

  it("a runner abort is not echoed back", async () => {
    const port = await listen(() => undefined);
    const h = harness();
    h.ps.handle({ kind: "ports.allow", ports: [port] });
    h.ps.handle({ kind: "port.open", streamId: "x", port });
    await h.until(() => h.of("port.opened", "x").length === 1);
    h.ps.handle({ kind: "port.close", streamId: "x", mode: "abort" });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.of("port.close", "x")).toHaveLength(0);
    expect(h.ps.activeCount()).toBe(0);
  });
});

describe("reservedGuestPorts", () => {
  it("adds the port the open proxy actually bound to the static set", () => {
    const reserved = reservedGuestPorts("http://127.0.0.1:3131");
    expect([...reserved].sort((a, b) => a - b)).toEqual([22, 3131]);
  });

  it("adds nothing for an absent or malformed value", () => {
    expect([...reservedGuestPorts(undefined)]).toEqual([22]);
    expect([...reservedGuestPorts("not a url")]).toEqual([22]);
  });
});
