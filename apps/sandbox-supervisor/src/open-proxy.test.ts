import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  gatewayFromProxyUrl,
  OPEN_LANE_USER,
  OPEN_PROXY_URL_FILE,
  publishOpenProxyUrl,
  startOpenProxy,
  type OpenProxy,
} from "./open-proxy";

/**
 * A stand-in gateway: records every CONNECT it receives (authority + the
 * Proxy-Authorization it carried) and answers however the test says. On a
 * 200 it echoes back what the client sends, uppercased, so a test can prove
 * bytes crossed in both directions through the splice. `answer(0)` makes it
 * accept and then stay silent.
 */
interface FakeGateway {
  readonly port: number;
  readonly connects: ReadonlyArray<{
    authority: string;
    auth: string | undefined;
  }>;
  answer(status: number, body?: string): void;
  close(): Promise<void>;
}

const startFakeGateway = async (): Promise<FakeGateway> => {
  const connects: { authority: string; auth: string | undefined }[] = [];
  let reply: { status: number; body: string } = { status: 200, body: "" };
  const sockets = new Set<Socket>();
  const server: Server = createServer();
  server.on("connect", (req, socket, head) => {
    sockets.add(socket as Socket);
    connects.push({
      authority: req.url ?? "",
      auth: req.headers["proxy-authorization"],
    });
    if (reply.status === 0) return; // silent: never answers
    if (reply.status !== 200) {
      socket.end(
        `HTTP/1.1 ${String(reply.status)} Refused\r\n` +
          `content-type: application/json\r\n` +
          `content-length: ${String(Buffer.byteLength(reply.body))}\r\n\r\n` +
          reply.body,
      );
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    // The "origin": uppercase echo of everything the client sends.
    const echo = (chunk: Buffer) =>
      socket.write(chunk.toString().toUpperCase());
    if (head.length > 0) echo(head);
    socket.on("data", echo);
    socket.on("error", () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("no address");
  return {
    port: address.port,
    connects,
    answer: (status, body = "") => {
      reply = { status, body };
    },
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
};

/** Speak to the open proxy as a browser would: raw CONNECT, no credentials. */
const connectVia = (
  proxy: OpenProxy,
  authority: string,
): Promise<{ status: number; body: string; socket: Socket }> =>
  new Promise((resolve, reject) => {
    const socket = netConnect(proxy.port, "127.0.0.1", () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
      );
    });
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const split = buffered.indexOf("\r\n\r\n");
      if (split === -1) return;
      socket.removeListener("data", onData);
      const status = Number(
        buffered.subarray(0, split).toString().split(" ")[1],
      );
      const rest = buffered.subarray(split + 4);
      if (rest.length > 0) socket.unshift(rest);
      socket.pause();
      resolve({ status, body: "", socket });
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });

const readAll = (socket: Socket, timeoutMs = 2_000): Promise<string> =>
  new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => resolve(out), timeoutMs);
    socket.on("data", (c: Buffer) => (out += c.toString()));
    socket.on("end", () => {
      clearTimeout(timer);
      resolve(out);
    });
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.resume();
  });

/** Read until `expected` has arrived in full (a live pipe has no end to wait for). */
const readUntil = (
  socket: Socket,
  expected: string,
  timeoutMs = 2_000,
): Promise<string> =>
  new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(
      () => reject(new Error(`timed out with ${JSON.stringify(out)}`)),
      timeoutMs,
    );
    socket.on("data", (c: Buffer) => {
      out += c.toString();
      if (out.includes(expected)) {
        clearTimeout(timer);
        resolve(out);
      }
    });
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.resume();
  });

describe("gatewayFromProxyUrl", () => {
  it("reads host, port and the token from the sandbox proxy URL", () => {
    expect(
      gatewayFromProxyUrl("http://x:aoc_abc123@gateway.example:10255"),
    ).toEqual({ host: "gateway.example", port: 10255, token: "aoc_abc123" });
  });

  it("accepts the legacy token-as-username shape and URL-encoded tokens", () => {
    expect(gatewayFromProxyUrl("http://aoc_legacy:@gw:10255")?.token).toBe(
      "aoc_legacy",
    );
    expect(gatewayFromProxyUrl("http://x:aoc%2Fenc@gw:10255")?.token).toBe(
      "aoc/enc",
    );
  });

  it("is undefined without a URL, a host, or a credential", () => {
    expect(gatewayFromProxyUrl(undefined)).toBeUndefined();
    expect(gatewayFromProxyUrl("")).toBeUndefined();
    expect(gatewayFromProxyUrl("not a url")).toBeUndefined();
    expect(gatewayFromProxyUrl("http://gw:10255")).toBeUndefined();
  });
});

describe("open proxy", () => {
  let gateway: FakeGateway;
  let proxy: OpenProxy | undefined;

  afterEach(async () => {
    proxy?.close();
    proxy = undefined;
    await gateway.close();
  });

  const start = async (): Promise<OpenProxy> => {
    gateway = await startFakeGateway();
    // Port 0 preferred: the OS picks, so the suite never collides with a
    // real 3128 on the developer's machine. The fallback walk is covered
    // separately below.
    proxy = await startOpenProxy(
      { host: "127.0.0.1", port: gateway.port, token: "aoc_test_token" },
      0,
    );
    return proxy;
  };

  it("re-issues a CONNECT to the gateway as open:<token> and splices the bytes", async () => {
    const p = await start();
    const { status, socket } = await connectVia(p, "example.com:443");
    expect(status).toBe(200);

    expect(gateway.connects).toEqual([
      {
        authority: "example.com:443",
        auth: `Basic ${Buffer.from(`${OPEN_LANE_USER}:aoc_test_token`).toString("base64")}`,
      },
    ]);

    // Bytes up, bytes down: the fake origin uppercases what it receives.
    socket.write("hello origin");
    expect(await readUntil(socket, "HELLO ORIGIN")).toBe("HELLO ORIGIN");
    socket.destroy();
  });

  it("forwards the gateway's refusal to the client verbatim", async () => {
    const p = await start();
    gateway.answer(403, '{"error":"blocked_by_policy"}');
    const { status, socket } = await connectVia(p, "blocked.example:443");
    expect(status).toBe(403);
    const rest = await readAll(socket);
    expect(rest).toContain("blocked_by_policy");
  });

  it("refuses anything but CONNECT, so it is never the API proxy", async () => {
    const p = await start();
    const res = await fetch(`${p.url}/`, { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("CONNECT");
    expect(await res.text()).toContain("CONNECT only");
    // And nothing reached the gateway.
    expect(gateway.connects).toHaveLength(0);
  });

  it("rejects an authority that is not a bare host:port", async () => {
    const p = await start();
    // Node's parser already splits the request target at the first space, so
    // a CRLF can never reach req.url; what can is a target that is not a
    // host:port at all. None of these may become an upstream CONNECT line.
    for (const authority of [
      "http://evil.example/",
      "evil.example:443/path",
      "evil.example:443?x=1",
      "evil example:443",
    ]) {
      const { status } = await connectVia(p, authority);
      expect(status, authority).toBe(400);
    }
    expect(gateway.connects).toHaveLength(0);
  });

  it("walks up from a taken preferred port and reports the one it bound", async () => {
    gateway = await startFakeGateway();
    // Occupy a port, then ask the open proxy for exactly that one.
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen(0, "127.0.0.1", r));
    const taken = (squatter.address() as { port: number }).port;
    try {
      proxy = await startOpenProxy(
        { host: "127.0.0.1", port: gateway.port, token: "t" },
        taken,
      );
      expect(proxy.port).toBeGreaterThan(taken);
      expect(proxy.url).toBe(`http://127.0.0.1:${String(proxy.port)}`);
    } finally {
      squatter.close();
    }
  });

  it("answers 504 when the gateway never replies, instead of hanging the browser", async () => {
    // A gateway that accepts the TCP connection and then says nothing; a
    // short real timeout stands in for the production 15s.
    gateway = await startFakeGateway();
    gateway.answer(0);
    proxy = await startOpenProxy(
      { host: "127.0.0.1", port: gateway.port, token: "t" },
      0,
      200,
    );
    const started = Date.now();
    const { status } = await connectVia(proxy, "slow.example:443");
    expect(status).toBe(504);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });
});

describe("publishOpenProxyUrl", () => {
  it("never writes through a planted symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "open-proxy-"));
    const victim = join(dir, "victim");
    writeFileSync(victim, "untouched\n");
    // A symlink where the URL file lives, pointing at something else.
    rmSync(OPEN_PROXY_URL_FILE, { force: true });
    symlinkSync(victim, OPEN_PROXY_URL_FILE);
    try {
      publishOpenProxyUrl("http://127.0.0.1:3128");
      expect(readFileSync(victim, "utf8")).toBe("untouched\n");
      expect(lstatSync(OPEN_PROXY_URL_FILE).isSymbolicLink()).toBe(false);
      expect(readFileSync(OPEN_PROXY_URL_FILE, "utf8")).toBe(
        "http://127.0.0.1:3128\n",
      );
    } finally {
      rmSync(OPEN_PROXY_URL_FILE, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
