import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { SupervisorMessage } from "@onecli/agent-protocol";
import { createRunnerWsServer, type RunnerWsServer } from "./server";
import { parseSessionKeyring } from "./session";

/**
 * The control channel's auth (§5.1): the bootstrap token is single-use and
 * bound to one sandbox, and the sandbox id a message is attributed to comes
 * from the authenticated connection — never from the payload.
 */

const PORT = 18484;

let server: RunnerWsServer;
let received: Array<{ sandboxId: string; message: SupervisorMessage }>;

const connect = (query: string): Promise<{ ok: boolean; ws?: WebSocket }> =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/${query}`);
    ws.once("open", () => resolve({ ok: true, ws }));
    ws.once("error", () => resolve({ ok: false }));
  });

beforeEach(async () => {
  received = [];
  server = createRunnerWsServer({
    port: PORT,
    onMessage: (sandboxId, message) => received.push({ sandboxId, message }),
  });
  await server.listen();
});

afterEach(async () => {
  await server.close();
});

describe("upgrade auth", () => {
  it("accepts a freshly issued token", async () => {
    const token = server.issueToken("sb-1");
    const result = await connect(`?token=${token}`);
    expect(result.ok).toBe(true);
    result.ws?.close();
  });

  it("refuses a connection with no token", async () => {
    expect((await connect("")).ok).toBe(false);
  });

  it("refuses an unknown token", async () => {
    expect((await connect("?token=made-up")).ok).toBe(false);
  });

  it("refuses a REPLAY of an already-used token", async () => {
    const token = server.issueToken("sb-1");
    const first = await connect(`?token=${token}`);
    expect(first.ok).toBe(true);
    first.ws?.close();

    expect((await connect(`?token=${token}`)).ok).toBe(false);
  });

  it("invalidates the prior token when a sandbox is re-issued one", async () => {
    const first = server.issueToken("sb-1");
    const second = server.issueToken("sb-1");
    expect(second).not.toBe(first);

    expect((await connect(`?token=${first}`)).ok).toBe(false);
    const result = await connect(`?token=${second}`);
    expect(result.ok).toBe(true);
    result.ws?.close();
  });

  it("refuses a revoked token (the spawn failed before connect)", async () => {
    const token = server.issueToken("sb-1");
    server.revokeToken("sb-1");
    expect((await connect(`?token=${token}`)).ok).toBe(false);
  });

  it("issues tokens with real entropy, never a guessable id", () => {
    const token = server.issueToken("sb-1");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toContain("sb-1");
  });
});

describe("message attribution", () => {
  const send = async (token: string, raw: string) => {
    const { ws } = await connect(`?token=${token}`);
    ws?.send(raw);
    await new Promise((resolve) => setTimeout(resolve, 30));
    ws?.close();
  };

  it("attributes a message to the CONNECTION's sandbox", async () => {
    const token = server.issueToken("sb-real");
    await send(token, JSON.stringify({ kind: "ready", harness: "jcode" }));

    expect(received).toEqual([
      { sandboxId: "sb-real", message: { kind: "ready", harness: "jcode" } },
    ]);
  });

  it("drops a non-JSON frame instead of crashing", async () => {
    const token = server.issueToken("sb-1");
    await send(token, "not json at all");
    expect(received).toEqual([]);
  });

  it("drops a frame that is not a valid supervisor message", async () => {
    const token = server.issueToken("sb-1");
    await send(token, JSON.stringify({ kind: "definitely-not-a-message" }));
    expect(received).toEqual([]);
  });

  it("serves /healthz for the container health check", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("404s any other HTTP path (this is not a public API)", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/v1/runner/work`);
    expect(response.status).toBe(404);
  });
});

describe("keepalive", () => {
  it("pings every live connection on the configured cadence — what keeps an idle channel alive across a load balancer's TCP idle timeout", async () => {
    // A dedicated server on its own port so the cadence override never
    // touches the shared beforeEach instance.
    const pinger = createRunnerWsServer({
      port: PORT + 1,
      onMessage: () => undefined,
      pingIntervalMs: 20,
    });
    await pinger.listen();
    try {
      const token = pinger.issueToken("sb-ping");
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${PORT + 1}/?token=${token}`,
        );
        socket.once("open", () => resolve(socket));
        socket.once("error", reject);
      });
      const pinged = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 1_000);
        ws.once("ping", () => {
          clearTimeout(timeout);
          resolve(true);
        });
      });
      expect(pinged).toBe(true);
      ws.close();
    } finally {
      await pinger.close();
    }
  });
});

/**
 * The resumable channel. A runner holding a session keyring hands every
 * freshly connected supervisor a `session` work item (its credential + the
 * runner's ack cursor); the supervisor presents the credential on reconnect,
 * and ANY runner process holding the keyring accepts it against the
 * container it knows for that sandbox. Sequenced frames are applied at most
 * once; bare frames (an old supervisor) pass through untouched.
 */
describe("resumable session", () => {
  const KEYRING = "k1.secret-for-tests";
  const containers = new Map<string, string>();

  /**
   * Items the server sends, in order. Attached at connect time: the session
   * hand-off is sent inside the upgrade, so a listener added after `open`
   * resolves can already have missed it.
   */
  const inbox = new WeakMap<WebSocket, unknown[]>();
  const open = (query: string): Promise<{ ok: boolean; ws?: WebSocket }> =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/${query}`);
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

  const withSessions = async () => {
    await server.close();
    server = createRunnerWsServer({
      port: PORT,
      onMessage: (sandboxId, message) => received.push({ sandboxId, message }),
      sessions: {
        keyring: parseSessionKeyring(KEYRING)!,
        containerRefOf: (sandboxId) => containers.get(sandboxId),
      },
    });
    await server.listen();
  };

  beforeEach(() => {
    containers.clear();
  });

  it("hands a session to a bootstrap connect, and a RESTARTED server accepts it", async () => {
    await withSessions();
    containers.set("sb-1", "ctr-1");
    const { ws } = await open(`?token=${server.issueToken("sb-1")}`);
    const session = await nextItem(ws!);
    expect(session).toMatchObject({ kind: "session", ack: 0 });
    const credential = (session as { credential: string }).credential;
    ws!.close();

    // The whole point: a NEW process, same keyring, no memory of the token.
    await withSessions();
    containers.set("sb-1", "ctr-1");
    const resumed = await open(
      `?session=${encodeURIComponent(credential)}&sandbox=sb-1`,
    );
    expect(resumed.ok).toBe(true);
    expect(server.connection("sb-1")).toBeDefined();
    // And it hands the session again (same credential: same facts, same key).
    expect(await nextItem(resumed.ws!)).toMatchObject({
      kind: "session",
      credential,
    });
    resumed.ws!.close();
  });

  it("hands the session LATE when the supervisor connects before its container ref is known (the cloud backend's order)", async () => {
    // The cloud backend's createSandbox returns only once the sandbox is
    // running, and the supervisor dials in the moment it runs, so the
    // connect arrives BEFORE the runner records the container ref. A
    // session can only be signed over a ref, so the connect carries none;
    // the runner then names the ref and the session must follow on the live
    // socket. Without this no such supervisor would hold a session, and a
    // runner roll would sever every channel as before.
    await withSessions();
    const { ws } = await open(`?token=${server.issueToken("sb-1")}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inbox.get(ws!)).toEqual([]); // nothing to sign over yet

    containers.set("sb-1", "ctr-1");
    server.containerKnown("sb-1");

    const session = await nextItem(ws!);
    expect(session).toMatchObject({ kind: "session", ack: 0 });
    // A real credential for THIS container: a restarted server accepts it.
    const credential = (session as { credential: string }).credential;
    ws!.close();
    await withSessions();
    containers.set("sb-1", "ctr-1");
    expect(
      (await open(`?session=${encodeURIComponent(credential)}&sandbox=sb-1`))
        .ok,
    ).toBe(true);
  });

  it("containerKnown is a no-op with no live socket, for a socket that already holds a session, and without a keyring", async () => {
    await withSessions();
    containers.set("sb-1", "ctr-1");
    server.containerKnown("sb-1"); // not connected yet: nothing to send to
    const { ws } = await open(`?token=${server.issueToken("sb-1")}`);
    expect(await nextItem(ws!)).toMatchObject({ kind: "session" });
    server.containerKnown("sb-1"); // already handed at connect
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inbox.get(ws!)).toEqual([]);
    ws!.close();

    // Keyless server: the call exists on the seam and does nothing.
    const plain = await open(`?token=${server.issueToken("sb-2")}`);
    await server.close();
    server = createRunnerWsServer({
      port: PORT,
      onMessage: (sandboxId, message) => received.push({ sandboxId, message }),
    });
    await server.listen();
    expect(() => server.containerKnown("sb-2")).not.toThrow();
    plain.ws?.close();
  });

  it("a RECREATE drops the replaced container's socket, so the new container's session can never be handed to the old one", async () => {
    // issueToken means a new container. If the old one's socket is still
    // registered (a half-open flow the runner never saw close), a late
    // hand-off for the NEW container's ref must not land on it: the
    // credential is bound to one container, and the old socket is not it.
    await withSessions();
    const old = await open(`?token=${server.issueToken("sb-1")}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const closed = new Promise((resolve) => old.ws!.once("close", resolve));

    server.issueToken("sb-1"); // the recreate
    await closed;
    expect(server.connection("sb-1")).toBeUndefined();

    containers.set("sb-1", "ctr-new");
    server.containerKnown("sb-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inbox.get(old.ws!)).toEqual([]);
  });

  it("refuses a session for a container this runner does not know, and one for the wrong sandbox", async () => {
    await withSessions();
    containers.set("sb-1", "ctr-1");
    const { ws } = await open(`?token=${server.issueToken("sb-1")}`);
    const { credential } = (await nextItem(ws!)) as { credential: string };
    ws!.close();

    // Container recreated (or never seen by this process): dead credential.
    containers.set("sb-1", "ctr-2");
    expect(
      (await open(`?session=${encodeURIComponent(credential)}&sandbox=sb-1`))
        .ok,
    ).toBe(false);
    // Right credential, wrong sandbox claim.
    containers.set("sb-1", "ctr-1");
    containers.set("sb-2", "ctr-1");
    expect(
      (await open(`?session=${encodeURIComponent(credential)}&sandbox=sb-2`))
        .ok,
    ).toBe(false);
    // Missing either parameter is simply refused.
    expect((await open(`?session=${encodeURIComponent(credential)}`)).ok).toBe(
      false,
    );
    expect((await open("?sandbox=sb-1")).ok).toBe(false);
  });

  it("without a keyring: no session is handed out and ?session= is refused", async () => {
    // The default server (beforeEach) has no sessions.
    const { ws } = await open(`?token=${server.issueToken("sb-1")}`);
    expect(await nextItem(ws!)).toBeUndefined();
    ws!.close();
    expect((await open("?session=v1.k1.deadbeef&sandbox=sb-1")).ok).toBe(false);
  });

  it("keeps ONE live channel per sandbox: a resumed connect replaces the old socket", async () => {
    await withSessions();
    containers.set("sb-1", "ctr-1");
    const first = await open(`?token=${server.issueToken("sb-1")}`);
    const { credential } = (await nextItem(first.ws!)) as {
      credential: string;
    };
    const closed = new Promise((resolve) => first.ws!.once("close", resolve));
    const second = await open(
      `?session=${encodeURIComponent(credential)}&sandbox=sb-1`,
    );
    await closed;
    await nextItem(second.ws!);
    // Work goes to the live socket only.
    server.connection("sb-1")!.send({ kind: "shutdown" });
    expect(await nextItem(second.ws!)).toEqual({ kind: "shutdown" });
    second.ws!.close();
  });

  it("applies a sequenced frame once: a replay of an acked seq is dropped, the gap is applied in order, and the next hand-off carries the cursor", async () => {
    await withSessions();
    containers.set("sb-1", "ctr-1");
    const { ws } = await open(`?token=${server.issueToken("sb-1")}`);
    const { credential } = (await nextItem(ws!)) as { credential: string };
    const frame = (seq: number) =>
      JSON.stringify({ seq, message: { kind: "ready", harness: `h${seq}` } });
    ws!.send(frame(1));
    ws!.send(frame(2));
    ws!.send(frame(2)); // replay
    ws!.send(frame(1)); // replay
    ws!.send(frame(3));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      received.map((r) => (r.message as { harness: string }).harness),
    ).toEqual(["h1", "h2", "h3"]);
    // The cursor the next connect carries: everything up to 3 is applied.
    const again = await open(
      `?session=${encodeURIComponent(credential)}&sandbox=sb-1`,
    );
    expect(await nextItem(again.ws!)).toMatchObject({
      kind: "session",
      ack: 3,
    });
    again.ws!.close();
  });

  it("acks applied frames back to the supervisor while connected", async () => {
    await withSessions();
    containers.set("sb-1", "ctr-1");
    const { ws } = await open(`?token=${server.issueToken("sb-1")}`);
    await nextItem(ws!);
    ws!.send(
      JSON.stringify({ seq: 5, message: { kind: "ready", harness: "x" } }),
    );
    expect(await nextItem(ws!)).toEqual({ kind: "ack", seq: 5 });
    ws!.close();
  });

  it("passes a BARE frame from an old supervisor straight through, with no ack and no cursor", async () => {
    await withSessions();
    containers.set("sb-1", "ctr-1");
    const { ws } = await open(`?token=${server.issueToken("sb-1")}`);
    const { credential } = (await nextItem(ws!)) as { credential: string };
    ws!.send(JSON.stringify({ kind: "ready", harness: "old" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(received).toEqual([
      { sandboxId: "sb-1", message: { kind: "ready", harness: "old" } },
    ]);
    expect(inbox.get(ws!)).toEqual([]); // no ack for a bare frame
    const again = await open(
      `?session=${encodeURIComponent(credential)}&sandbox=sb-1`,
    );
    expect(await nextItem(again.ws!)).toMatchObject({
      kind: "session",
      ack: 0,
    });
    again.ws!.close();
  });

  it("remembers WHEN a session-holding sandbox disconnected, and forgets it on reconnect", async () => {
    await withSessions();
    containers.set("sb-1", "ctr-1");
    const { ws } = await open(`?token=${server.issueToken("sb-1")}`);
    const { credential } = (await nextItem(ws!)) as { credential: string };
    expect(server.disconnectedAt("sb-1")).toBeUndefined();
    const closed = new Promise((resolve) => ws!.once("close", resolve));
    ws!.close();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.disconnectedAt("sb-1")).toBeTypeOf("number");
    const again = await open(
      `?session=${encodeURIComponent(credential)}&sandbox=sb-1`,
    );
    await nextItem(again.ws!);
    expect(server.disconnectedAt("sb-1")).toBeUndefined();
    again.ws!.close();
  });
});
