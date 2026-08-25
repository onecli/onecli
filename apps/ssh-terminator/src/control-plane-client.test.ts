import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ControlPlaneUnreachableError,
  createControlPlaneClient,
  type ControlPlaneClient,
} from "./control-plane-client";

/**
 * The heartbeat's status law, over a REAL socket: a revocation is ONLY a 200
 * with `{revoked: true}` — every non-ok answer and every malformed 200 is
 * transport-class (ControlPlaneUnreachableError, the caller's strike
 * accounting), never a revoked verdict. The old collapse of a non-ok into
 * `{revoked: true}` killed live SSH sessions with a "your access was revoked"
 * lie on the first WAF-blocked or deploy-window beat.
 */

let server: Server;
let client: ControlPlaneClient;
let answer: { status: number; body: string };

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("server did not bind");
  }
  client = createControlPlaneClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    getSecret: () => "terminator-secret",
  });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  answer = { status: 200, body: JSON.stringify({ revoked: false }) };
});

describe("heartbeat status law", () => {
  it("passes a clean 200 verdict through", async () => {
    await expect(client.heartbeat("sess-1", true)).resolves.toEqual({
      revoked: false,
    });
  });

  it("passes a real revocation (200 + revoked:true) through with its reason", async () => {
    answer = {
      status: 200,
      body: JSON.stringify({ revoked: true, reason: "access_revoked" }),
    };
    await expect(client.heartbeat("sess-1", true)).resolves.toEqual({
      revoked: true,
      reason: "access_revoked",
    });
  });

  it.each([403, 401, 404, 500, 503])(
    "a %i answer throws transport-class, never a revoked verdict",
    async (status) => {
      answer = { status, body: JSON.stringify({ error: "blocked" }) };
      await expect(client.heartbeat("sess-1", true)).rejects.toBeInstanceOf(
        ControlPlaneUnreachableError,
      );
    },
  );

  it("a 200 with a non-object body throws, never a guess", async () => {
    answer = { status: 200, body: "null" };
    await expect(client.heartbeat("sess-1", true)).rejects.toBeInstanceOf(
      ControlPlaneUnreachableError,
    );
  });

  it("a 200 without a boolean verdict throws, never a guess", async () => {
    answer = { status: 200, body: JSON.stringify({ reason: "whatever" }) };
    await expect(client.heartbeat("sess-1", true)).rejects.toBeInstanceOf(
      ControlPlaneUnreachableError,
    );
  });

  it("a transport failure throws the same class (one strike path)", async () => {
    const dead = createControlPlaneClient({
      baseUrl: "http://127.0.0.1:1", // nothing listens there
      getSecret: () => "terminator-secret",
    });
    await expect(dead.heartbeat("sess-1", true)).rejects.toBeInstanceOf(
      ControlPlaneUnreachableError,
    );
  });
});
