import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type {
  RunnerChannelClaimRequest,
  RunnerChannelClaimResponse,
  SupervisorMessage,
} from "@onecli/agent-protocol";
import {
  createRunnerWsServer,
  hashBootstrapToken,
  type ChannelPlane,
  type RunnerWsServer,
} from "./server";
import { parseSessionKeyring } from "./session";

/**
 * The control channel's two doors, with the control plane as the source of
 * truth for both (the runner may run as several copies, and a supervisor
 * reaches whichever one the load balancer picks):
 *
 * - the bootstrap TOKEN (a first connect) is claimed from the control plane
 *   by its hash: single use across every copy, and the answer names the
 *   sandbox and container it was minted for;
 * - the SESSION (a reconnect) is verified locally against the container the
 *   control plane knows, then claimed.
 *
 * The sandbox a message is attributed to comes from the authenticated
 * connection, never from the payload. These tests drive the real server
 * with a fake control plane holding the claim rules.
 */

/** The bound port of the current server (each start binds a free one). */
let port = 0;
const KEYRING = "k1.secret-for-tests";
const keyring = parseSessionKeyring(KEYRING)!;

/** The control plane's channel rules, in memory. */
const fakePlane = () => {
  const spawns = new Map<string, { sandboxId: string; containerRef: string }>();
  const current = new Map<string, string>();
  const holders = new Map<string, string>();
  const claims: RunnerChannelClaimRequest[] = [];
  const releases: string[] = [];
  let down = false;
  const plane: ChannelPlane & {
    spawn(sandboxId: string, containerRef: string, token: string): void;
    claims: RunnerChannelClaimRequest[];
    releases: string[];
    holders: Map<string, string>;
    setDown(value: boolean): void;
  } = {
    claims,
    releases,
    holders,
    setDown: (value) => {
      down = value;
    },
    spawn(sandboxId, containerRef, token) {
      spawns.set(hashBootstrapToken(token), { sandboxId, containerRef });
      current.set(sandboxId, containerRef);
    },
    async claim(
      claim: RunnerChannelClaimRequest,
    ): Promise<RunnerChannelClaimResponse | null> {
      claims.push(claim);
      if (down) throw new Error("control plane unreachable");
      if (claim.door === "token") {
        const spawn = spawns.get(claim.tokenHash);
        if (!spawn) return null;
        spawns.delete(claim.tokenHash); // single use
        holders.set(spawn.sandboxId, claim.connectionId);
        return spawn;
      }
      if (current.get(claim.sandboxId) !== claim.containerRef) return null;
      holders.set(claim.sandboxId, claim.connectionId);
      return { sandboxId: claim.sandboxId, containerRef: claim.containerRef };
    },
    async containerOf(sandboxId) {
      if (down) throw new Error("control plane unreachable");
      return current.get(sandboxId);
    },
    release(connectionId) {
      releases.push(connectionId);
    },
  };
  return plane;
};

let plane: ReturnType<typeof fakePlane>;
let server: RunnerWsServer;
let received: Array<{ sandboxId: string; message: SupervisorMessage }>;

/** Items the server sends, captured from connect (the session hand-off is
 * sent right after the upgrade, before `open` resolves for the test). */
const inbox = new WeakMap<WebSocket, unknown[]>();
const open = (query: string): Promise<{ ok: boolean; ws?: WebSocket }> =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`);
    const items: unknown[] = [];
    inbox.set(ws, items);
    ws.on("message", (data) => items.push(JSON.parse(data.toString())));
    ws.once("open", () => resolve({ ok: true, ws }));
    ws.once("error", () => resolve({ ok: false }));
  });
const nextItem = async (ws: WebSocket): Promise<unknown> => {
  const items = inbox.get(ws)!;
  for (let i = 0; i < 100 && items.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return items.shift();
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const start = async (sessions = true) => {
  server = createRunnerWsServer({
    port: 0,
    onMessage: (sandboxId, message) => received.push({ sandboxId, message }),
    channels: plane,
    ...(sessions && { keyring }),
    reclaimMinMs: 10,
  });
  await server.listen();
  port = server.boundPort();
};

/** Spawn a sandbox on the fake plane and connect it through the token door. */
const firstConnect = async (sandboxId = "sb-1", containerRef = "ctr-1") => {
  const token = `${sandboxId}-${containerRef}-token`.padEnd(64, "0");
  plane.spawn(sandboxId, containerRef, token);
  const opened = await open(`?token=${token}`);
  return { ...opened, token };
};

beforeEach(async () => {
  received = [];
  plane = fakePlane();
  await start();
});

afterEach(async () => {
  await server.close();
});

describe("the bootstrap token door", () => {
  it("claims the token by its hash and attributes the socket to the sandbox the control plane names", async () => {
    const { ok, ws, token } = await firstConnect();
    expect(ok).toBe(true);
    const claim = plane.claims[0];
    expect(claim).toMatchObject({
      door: "token",
      tokenHash: createHash("sha256").update(token).digest("hex"),
    });
    // The raw token never leaves the copy.
    expect(JSON.stringify(plane.claims)).not.toContain(token);
    expect(server.connection("sb-1")).toBeDefined();
    ws!.send(JSON.stringify({ kind: "ready", harness: "x" }));
    await settle();
    expect(received).toEqual([
      { sandboxId: "sb-1", message: { kind: "ready", harness: "x" } },
    ]);
  });

  it("refuses an unknown token, a replayed token, and no credential at all, hint-free", async () => {
    expect((await open(`?token=${"f".repeat(64)}`)).ok).toBe(false);
    const { ws, token } = await firstConnect();
    ws!.close();
    expect((await open(`?token=${token}`)).ok).toBe(false);
    expect((await open("")).ok).toBe(false);
  });

  it("refuses when the control plane cannot be asked: a first connect has nothing local to trust", async () => {
    plane.setDown(true);
    const token = "a".repeat(64);
    expect((await open(`?token=${token}`)).ok).toBe(false);
  });

  it("hands the session at connect, signed over the container the control plane named", async () => {
    const { ws } = await firstConnect("sb-1", "ctr-9");
    const session = (await nextItem(ws!)) as {
      kind: string;
      credential: string;
    };
    expect(session).toMatchObject({ kind: "session", ack: 0 });
    expect(keyring.verify(session.credential, "sb-1", "ctr-9")).toBe(true);
  });

  it("without a keyring: no session, and the session door is shut", async () => {
    await server.close();
    await start(false);
    const { ws } = await firstConnect();
    expect(await nextItem(ws!)).toBeUndefined();
    expect((await open("?session=v1.k1.deadbeef&sandbox=sb-1")).ok).toBe(false);
  });
});

describe("the session door", () => {
  const credentialFor = async () => {
    const { ws } = await firstConnect();
    const { credential } = (await nextItem(ws!)) as { credential: string };
    const closed = new Promise((resolve) => ws!.once("close", resolve));
    ws!.close();
    await closed;
    return credential;
  };

  it("any copy accepts a session for the sandbox's current container (a fresh process, same key)", async () => {
    const credential = await credentialFor();
    await server.close();
    await start(); // another copy: no memory of the token or the socket
    const resumed = await open(
      `?session=${encodeURIComponent(credential)}&sandbox=sb-1`,
    );
    expect(resumed.ok).toBe(true);
    expect(server.connection("sb-1")).toBeDefined();
    expect(plane.claims.at(-1)).toMatchObject({
      door: "session",
      sandboxId: "sb-1",
      containerRef: "ctr-1",
    });
    expect(await nextItem(resumed.ws!)).toMatchObject({
      kind: "session",
      credential,
    });
  });

  it("refuses a session for a replaced container, a wrong sandbox, or a forged credential", async () => {
    const credential = await credentialFor();
    plane.spawn("sb-1", "ctr-2", "x".repeat(64)); // recreated
    expect(
      (await open(`?session=${encodeURIComponent(credential)}&sandbox=sb-1`))
        .ok,
    ).toBe(false);
    expect(
      (await open(`?session=${encodeURIComponent(credential)}&sandbox=sb-2`))
        .ok,
    ).toBe(false);
    expect((await open("?session=v1.k1.deadbeef&sandbox=sb-1")).ok).toBe(false);
    expect((await open("?sandbox=sb-1")).ok).toBe(false);
  });

  it("a forged credential is refused locally: the control plane is never asked", async () => {
    const before = plane.claims.length;
    expect(
      (await open(`?session=v1.k1.${"0".repeat(64)}&sandbox=sb-1`)).ok,
    ).toBe(false);
    expect(plane.claims.length).toBe(before);
  });

  it("a forged credential for a sandbox this copy knows is refused even while the control plane is down", async () => {
    // The offline path trusts only what verifies locally: knowing the
    // sandbox is not a credential.
    await credentialFor();
    plane.setDown(true);
    expect(
      (await open(`?session=v1.k1.${"0".repeat(64)}&sandbox=sb-1`)).ok,
    ).toBe(false);
    expect(server.connection("sb-1")).toBeUndefined();
  });

  it("accepts a locally valid session while the control plane is down, and claims the channel once it is back", async () => {
    // A running sandbox must keep running through a control-plane outage:
    // the credential verifies against the container last learned, and the
    // claim is retried in the background.
    const credential = await credentialFor();
    plane.setDown(true);
    const resumed = await open(
      `?session=${encodeURIComponent(credential)}&sandbox=sb-1`,
    );
    expect(resumed.ok).toBe(true);
    expect(server.connection("sb-1")).toBeDefined();
    const before = plane.holders.get("sb-1");
    plane.setDown(false);
    for (let i = 0; i < 150 && plane.holders.get("sb-1") === before; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // The owed claim landed for the socket admitted offline.
    expect(plane.holders.get("sb-1")).not.toBe(before);
    expect(plane.claims.at(-1)).toMatchObject({
      door: "session",
      connectionId: plane.holders.get("sb-1"),
    });
  });

  it("closes a session the control plane refuses once it can be asked (a replaced container)", async () => {
    const credential = await credentialFor();
    plane.setDown(true);
    const resumed = await open(
      `?session=${encodeURIComponent(credential)}&sandbox=sb-1`,
    );
    expect(resumed.ok).toBe(true);
    plane.spawn("sb-1", "ctr-2", "y".repeat(64));
    const closed = new Promise<number>((resolve) =>
      resumed.ws!.once("close", (code) => resolve(code)),
    );
    plane.setDown(false);
    expect(await closed).toBe(1008);
    // The client's close can land before the server's own close handler
    // runs; the server drops the socket on that handler.
    await vi.waitFor(() => expect(server.connection("sb-1")).toBeUndefined());
  });

  it("keeps ONE live socket per sandbox: a newer connect replaces the old one", async () => {
    const { ws: first } = await firstConnect();
    const { credential } = (await nextItem(first!)) as { credential: string };
    const closed = new Promise((resolve) => first!.once("close", resolve));
    const second = await open(
      `?session=${encodeURIComponent(credential)}&sandbox=sb-1`,
    );
    await closed;
    await nextItem(second.ws!);
    server.connection("sb-1")!.send({ kind: "shutdown" });
    expect(await nextItem(second.ws!)).toEqual({ kind: "shutdown" });
  });
});

describe("release", () => {
  it("releases the channel when its socket closes, and not for a socket that was replaced", async () => {
    const { ws: first } = await firstConnect();
    const { credential } = (await nextItem(first!)) as { credential: string };
    const firstClaim = plane.claims[0]!.connectionId;
    const second = await open(
      `?session=${encodeURIComponent(credential)}&sandbox=sb-1`,
    );
    await settle();
    // The replaced socket's close names ITS connection; the control plane
    // fences it (no-op), but the copy must not release the live one.
    expect(plane.releases).not.toContain(plane.claims.at(-1)!.connectionId);
    const closed = new Promise((resolve) => second.ws!.once("close", resolve));
    second.ws!.close();
    await closed;
    await settle();
    expect(plane.releases).toContain(plane.claims.at(-1)!.connectionId);
    expect(
      plane.releases.filter((id) => id === firstClaim).length,
    ).toBeLessThanOrEqual(1);
  });

  it("fires the disconnect listeners with the container the socket was for", async () => {
    // Port streams die with the socket; the runner checks THAT container.
    const gone: Array<[string, string]> = [];
    server.onDisconnect((sandboxId, containerRef) =>
      gone.push([sandboxId, containerRef]),
    );
    const { ws } = await firstConnect();
    const closed = new Promise((resolve) => ws!.once("close", resolve));
    ws!.close();
    await closed;
    await settle();
    expect(gone).toEqual([["sb-1", "ctr-1"]]);
  });
});

describe("sequenced frames (the resumable channel)", () => {
  it("applies a frame once, acks it, and the next hand-off carries the cursor", async () => {
    const { ws } = await firstConnect();
    const { credential } = (await nextItem(ws!)) as { credential: string };
    const frame = (seq: number) =>
      JSON.stringify({ seq, message: { kind: "ready", harness: `h${seq}` } });
    ws!.send(frame(1));
    ws!.send(frame(2));
    ws!.send(frame(2));
    ws!.send(frame(3));
    expect(await nextItem(ws!)).toEqual({ kind: "ack", seq: 1 });
    await settle();
    expect(
      received.map((r) => (r.message as { harness: string }).harness),
    ).toEqual(["h1", "h2", "h3"]);
    const again = await open(
      `?session=${encodeURIComponent(credential)}&sandbox=sb-1`,
    );
    expect(await nextItem(again.ws!)).toMatchObject({
      kind: "session",
      ack: 3,
    });
  });

  it("passes a bare frame from an old supervisor straight through", async () => {
    const { ws } = await firstConnect();
    await nextItem(ws!);
    ws!.send(JSON.stringify({ kind: "ready", harness: "old" }));
    await settle();
    expect(received).toEqual([
      { sandboxId: "sb-1", message: { kind: "ready", harness: "old" } },
    ]);
  });

  it("drops non-JSON and invalid frames instead of crashing", async () => {
    const { ws } = await firstConnect();
    await nextItem(ws!);
    ws!.send("not json");
    ws!.send(JSON.stringify({ kind: "nope" }));
    await settle();
    expect(received).toEqual([]);
    expect(server.connection("sb-1")).toBeDefined();
  });
});

describe("shutdown", () => {
  it("drain closes every socket with 1012 (service restart) so supervisors reconnect to another copy", async () => {
    const { ws } = await firstConnect();
    const code = new Promise<number>((resolve) =>
      ws!.once("close", (c) => resolve(c)),
    );
    await server.drain();
    expect(await code).toBe(1012);
    // A copy that is draining refuses new connects WITHOUT claiming: the
    // supervisor's single-use token stays good for the copy it dials next.
    const claimsBefore = plane.claims.length;
    expect((await firstConnect("sb-2")).ok).toBe(false);
    expect(plane.claims.length).toBe(claimsBefore);
  });

  it("a first connect claimed just before the drain is completed, handed its session, then moved on", async () => {
    // Its token is already spent: refusing it now would strand the sandbox.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claim = plane.claim.bind(plane);
    plane.claim = async (request) => {
      const answer = await claim(request);
      await gate;
      return answer;
    };
    const token = "c".repeat(64);
    plane.spawn("sb-3", "ctr-3", token);
    const connecting = open(`?token=${token}`);
    await settle();
    const draining = server.drain();
    release();
    const { ok, ws } = await connecting;
    expect(ok).toBe(true);
    const closed = new Promise<number>((resolve) =>
      ws!.once("close", (c) => resolve(c)),
    );
    expect(await nextItem(ws!)).toMatchObject({ kind: "session" });
    expect(await closed).toBe(1012);
    await draining;
  });

  it("serves /healthz, and stops answering ready once draining", async () => {
    const health = async () =>
      (await fetch(`http://127.0.0.1:${port}/healthz`)).status;
    expect(await health()).toBe(200);
    await server.drain();
    expect(await health()).toBe(503);
  });
});

describe("keepalive", () => {
  it("pings every live connection on the configured cadence", async () => {
    await server.close();
    server = createRunnerWsServer({
      port: 0,
      onMessage: () => undefined,
      channels: plane,
      keyring,
      pingIntervalMs: 20,
    });
    await server.listen();
    port = server.boundPort();
    const { ws } = await firstConnect();
    const pinged = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 1_000);
      ws!.once("ping", () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    expect(pinged).toBe(true);
  });
});
