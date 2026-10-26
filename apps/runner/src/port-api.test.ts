import { request, createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { PORT_STREAM_UPGRADE, startPortApi } from "./port-api";
import { PortOpenError } from "./port-hub";

const TOKEN = "t".repeat(40);
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

/** A hub whose "guest" is a real HTTP server we control. */
const fakeHub = (guestPort: number | null, openError?: PortOpenError) => {
  const allowed: Array<[string, number[]]> = [];
  return {
    allowed,
    open: async (): Promise<Duplex> => {
      if (openError) throw openError;
      const sock: Socket = connect({ host: "127.0.0.1", port: guestPort! });
      await new Promise((r) => sock.once("connect", r));
      return sock;
    },
    setAllowed: (sandboxId: string, ports: number[]) => {
      allowed.push([sandboxId, ports]);
      return sandboxId !== "offline";
    },
  };
};

const start = async (
  hub: ReturnType<typeof fakeHub>,
  options: { allowlistFreshMs?: number; now?: () => number } = {},
) => {
  const calls: string[] = [];
  const api = await startPortApi({
    port: 0,
    host: "127.0.0.1",
    token: TOKEN,
    hub,
    allowedPorts: async (id) => {
      calls.push(id);
      if (id === "cp-down") throw new Error("control plane unreachable");
      return [80, 8080];
    },
    ...options,
  });
  closers.push(() => api.close());
  return { port: (api.address() as AddressInfo).port, calls, api };
};

/** Upgrade, then speak raw HTTP/1.1 over the stream (what the relay does). */
const upgradeAndGet = (port: number, path: string, auth = `Bearer ${TOKEN}`) =>
  new Promise<{ status: number; errorCode?: string; body?: string }>(
    (resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port,
        path,
        headers: {
          connection: "upgrade",
          upgrade: PORT_STREAM_UPGRADE,
          authorization: auth,
        },
      });
      req.on("upgrade", (_res, socket) => {
        let buf = "";
        socket.on("data", (c: Buffer) => (buf += c.toString()));
        socket.on("end", () => resolve({ status: 101, body: buf }));
        socket.write(
          "GET /hello HTTP/1.1\r\nhost: guest\r\nconnection: close\r\n\r\n",
        );
      });
      req.on("response", (res) => {
        resolve({
          status: res.statusCode ?? 0,
          errorCode: res.headers["x-onecli-port-error"] as string | undefined,
        });
        res.resume();
      });
      req.on("error", reject);
      req.end();
    },
  );

describe("runner port API", () => {
  it("upgrades to a raw byte stream that carries HTTP to the guest", async () => {
    const guest: Server = createServer((req, res) =>
      res.end(`guest saw ${req.url}`),
    );
    await new Promise<void>((r) => guest.listen(0, "127.0.0.1", () => r()));
    closers.push(() => new Promise<void>((r) => guest.close(() => r())));
    const { port } = await start(
      fakeHub((guest.address() as AddressInfo).port),
    );
    const r = await upgradeAndGet(port, "/v1/sandboxes/sbx/ports/80/stream");
    expect(r.status).toBe(101);
    expect(r.body).toContain("guest saw /hello");
  });

  it("refuses a wrong or missing token (upgrade and plain)", async () => {
    const { port } = await start(fakeHub(null));
    expect(
      (
        await upgradeAndGet(
          port,
          "/v1/sandboxes/sbx/ports/80/stream",
          "Bearer nope",
        )
      ).status,
    ).toBe(401);
    expect(
      (await upgradeAndGet(port, "/v1/sandboxes/sbx/ports/80/stream", ""))
        .status,
    ).toBe(401);
    const plain = await new Promise<number>((resolve) => {
      request(
        {
          host: "127.0.0.1",
          port,
          method: "PUT",
          path: "/v1/sandboxes/sbx/ports/allow",
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      ).end();
    });
    expect(plain).toBe(401);
  });

  it("maps hub refusals to status + machine code", async () => {
    for (const [code, status] of [
      ["not_allowed", 403],
      ["not_listening", 502],
      ["no_sandbox", 503],
      ["timeout", 504],
      ["limit", 429],
    ] as const) {
      const { port } = await start(fakeHub(null, new PortOpenError(code)));
      const r = await upgradeAndGet(port, "/v1/sandboxes/sbx/ports/80/stream");
      expect([r.status, r.errorCode]).toEqual([status, code]);
    }
  });

  it("rejects malformed paths and ids", async () => {
    const { port } = await start(fakeHub(null));
    for (const path of [
      "/v1/sandboxes/sbx/ports/99999/stream",
      "/v1/sandboxes/../ports/80/stream",
      "/v1/sandboxes/a%2Fb/ports/80/stream",
      "/v1/sandboxes/sbx/ports/80/stream/extra",
    ]) {
      const r = await upgradeAndGet(port, path);
      expect([400, 404]).toContain(r.status);
    }
  });

  it("an allowlist refresh arms ONLY what the control plane says, never the caller's body", async () => {
    // The relay holds this API's token; if it could name ports, a relay
    // compromise could make every listening guest port dialable.
    // MUTATION-PROOF: read the body again and the first assertion fails.
    const hub = fakeHub(null);
    const { port } = await start(hub);
    const put = (id: string, body: string) =>
      new Promise<number>((resolve) => {
        const req = request(
          {
            host: "127.0.0.1",
            port,
            method: "PUT",
            path: `/v1/sandboxes/${id}/ports/allow`,
            headers: { authorization: `Bearer ${TOKEN}` },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.end(body);
      });
    expect(await put("sbx", JSON.stringify({ ports: [22, 3306, 5432] }))).toBe(
      204,
    );
    expect(hub.allowed).toEqual([["sbx", [80, 8080]]]);
    expect(await put("offline", "")).toBe(503);
    // Control plane down: nothing is armed (fail closed).
    expect(await put("cp-down", "")).toBe(502);
    expect(hub.allowed.map(([id]) => id)).not.toContain("cp-down");
  });

  it("re-arms from the control plane once per sandbox per window, never per open; a PUT always re-arms", async () => {
    // A page load opens one stream per asset: without coalescing, every
    // asset would cost a control-plane read.
    const guest: Server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => guest.listen(0, "127.0.0.1", () => r()));
    closers.push(() => new Promise<void>((r) => guest.close(() => r())));
    let clock = 1_000_000;
    const hub = fakeHub((guest.address() as AddressInfo).port);
    const { port, calls } = await start(hub, {
      allowlistFreshMs: 5_000,
      now: () => clock,
    });
    const open = () => upgradeAndGet(port, "/v1/sandboxes/sbx/ports/80/stream");
    await open();
    await open();
    await open();
    expect(calls).toEqual(["sbx"]);
    expect(hub.allowed).toHaveLength(1);
    // Another sandbox has its own window.
    await upgradeAndGet(port, "/v1/sandboxes/other/ports/80/stream");
    expect(calls).toEqual(["sbx", "other"]);
    // The window lapses: the next open re-arms.
    clock += 5_001;
    await open();
    expect(calls).toEqual(["sbx", "other", "sbx"]);
    // An explicit refresh (the relay saw not_allowed) is never coalesced.
    const status = await new Promise<number>((resolve) => {
      request(
        {
          host: "127.0.0.1",
          port,
          method: "PUT",
          path: "/v1/sandboxes/sbx/ports/allow",
          headers: { authorization: `Bearer ${TOKEN}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      ).end();
    });
    expect(status).toBe(204);
    expect(calls).toEqual(["sbx", "other", "sbx", "sbx"]);
  });

  it("an arm is forgotten when the sandbox's channel closes (its next boot starts unarmed)", async () => {
    const guest: Server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => guest.listen(0, "127.0.0.1", () => r()));
    closers.push(() => new Promise<void>((r) => guest.close(() => r())));
    const { port, calls, api } = await start(
      fakeHub((guest.address() as AddressInfo).port),
    );
    await upgradeAndGet(port, "/v1/sandboxes/sbx/ports/80/stream");
    api.sandboxGone("sbx");
    await upgradeAndGet(port, "/v1/sandboxes/sbx/ports/80/stream");
    expect(calls).toEqual(["sbx", "sbx"]);
  });

  it("refuses to start with a short token", async () => {
    await expect(
      startPortApi({
        port: 0,
        token: "short",
        hub: fakeHub(null),
        allowedPorts: async () => [],
      }),
    ).rejects.toThrow(/at least 32/);
  });
});
