import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { SupervisorMessage } from "@onecli/agent-protocol";
import { createRunnerWsServer, type RunnerWsServer } from "./server";

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
  it("pings every live connection on the configured cadence — what keeps an idle channel alive across an NLB's TCP idle timeout", async () => {
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
