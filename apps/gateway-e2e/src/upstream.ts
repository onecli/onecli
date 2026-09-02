import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { flattenHeaders } from "./http.js";

/**
 * A stub origin server the gateway forwards to.
 *
 * Hand-rolled rather than pulled from a mocking library because the assertions
 * that matter here are about what the gateway *sent* — the exact header set,
 * including which headers it stripped and which it injected — and because the
 * TLS variants those libraries offer are either absent or unstable.
 *
 * It binds `127.0.0.1` explicitly: `localhost` would be resolved by Node with
 * verbatim DNS ordering and can answer `::1` first.
 */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  header(name: string): string | undefined;
}

export interface StubResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /**
   * Hold the response head for this long after the request arrives.
   *
   * The only way to have a request be genuinely in flight (fully received,
   * nothing written back) at a chosen moment — which is what shutdown tests
   * need to prove an in-flight request survives the signal.
   */
  readonly delayMs?: number;
}

/** A WebSocket upgrade the stub received, as it arrived on the wire. */
export interface RecordedUpgrade {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Header names and values in wire order, duplicates included.
   *
   * The gateway sets its own `Host` and its filter is what keeps the client's
   * from being forwarded alongside it. Node collapses duplicates in `headers`,
   * so only counting occurrences here tells "the filter dropped the client's
   * Host" (one) apart from "it forwarded it and Node hid it" (two).
   */
  readonly rawHeaders: ReadonlyArray<string>;
  header(name: string): string | undefined;
  /** Everything the client has sent through the pipe since the upgrade. */
  received(): string;
}

/** How the stub answers an upgrade. Defaults to a well-formed 101. */
export interface StubUpgradeResponse {
  /** Anything other than 101 exercises the gateway's passthrough path. */
  readonly status?: number;
  /** Extra response headers, to prove which ones the gateway forwards. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Body for a non-101 answer. */
  readonly body?: string;
}

/** A response written as separate chunks, so the client can observe streaming. */
export interface StubStream {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly chunks: ReadonlyArray<string>;
  /** Delay before each chunk after the first. */
  readonly gapMs: number;
}

export interface StubUpstream {
  readonly host: string;
  readonly port: number;
  /** `127.0.0.1:<port>` — what a request's Host header and target carry. */
  readonly authority: string;
  url(path: string): string;
  /** What the stub answers with. Defaults to `200 {}`. */
  respond(response: StubResponse): void;
  /**
   * Answer in timed chunks instead of one write.
   *
   * A gateway that buffers to EOF and a gateway that streams are
   * indistinguishable from a single-write stub — both deliver one body. Spacing
   * the chunks is the only way the difference becomes observable.
   */
  respondStream(stream: StubStream): void;
  requests(): ReadonlyArray<RecordedRequest>;
  waitForRequests(
    count: number,
    timeoutMs?: number,
  ): Promise<ReadonlyArray<RecordedRequest>>;
  close(): Promise<void>;
}

/**
 * A stub started with `websocket: true`.
 *
 * The upgrade surface lives on its own type rather than behind a doc comment
 * on the base one: called against a plain stub, `waitForUpgrades` hangs for
 * its full timeout and then reports "saw 0 upgrades", which reads like a
 * gateway bug rather than the harness misuse it is. The three `scenario`
 * accessors declare which one they hand back, so the compiler catches it.
 */
export interface WebSocketStubUpstream extends StubUpstream {
  /** How the stub answers upgrades from here on. */
  respondUpgrade(response: StubUpgradeResponse): void;
  upgrades(): ReadonlyArray<RecordedUpgrade>;
  waitForUpgrades(
    count: number,
    timeoutMs?: number,
  ): Promise<ReadonlyArray<RecordedUpgrade>>;
  /** Send bytes back down an established pipe, to prove the reverse direction. */
  sendToClient(text: string, index?: number): void;
}

/** RFC 6455's fixed GUID, concatenated with the client key to form the accept. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The `Sec-WebSocket-Accept` a conforming server returns for `key`. */
export const websocketAccept = (key: string): string =>
  createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");

/** Something waiting for a recorded collection to reach `count`. */
interface CountWaiter {
  count: number;
  resolve: () => void;
}

/**
 * Wait until `items` holds at least `count` entries.
 *
 * `items` is captured live — both callers push into the array in place — so
 * this reads the current length on every settle rather than a snapshot.
 */
const waitForCount = async <T>(
  items: ReadonlyArray<T>,
  waiters: Set<CountWaiter>,
  count: number,
  noun: string,
  timeoutMs = 5_000,
): Promise<ReadonlyArray<T>> => {
  if (items.length >= count) return items;
  let timer: NodeJS.Timeout | undefined;
  let waiter: CountWaiter | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        waiter = { count, resolve };
        waiters.add(waiter);
      }),
      new Promise<void>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `upstream saw ${String(items.length)} ${noun}(s), expected ${String(count)}, within ${String(timeoutMs)}ms`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    // Otherwise the loser of the race leaves a pending timer, or a waiter
    // that can never be satisfied, behind.
    if (timer !== undefined) clearTimeout(timer);
    if (waiter !== undefined) waiters.delete(waiter);
  }
  return items;
};

const record = (req: IncomingMessage, body: string): RecordedRequest => {
  const headers = flattenHeaders(req.headers);
  const url = req.url ?? "/";
  return {
    method: req.method ?? "GET",
    url,
    headers,
    body,
    header: (name: string) => headers[name.toLowerCase()],
  };
};

/**
 * A throwaway self-signed cert for the TLS stub.
 *
 * Generated with `openssl` rather than a Node library: it is present on both
 * macOS and the CI runner, and this avoids adding a dependency for four lines of
 * work. The IP SAN matters — TLS clients omit SNI when connecting to an address,
 * so identity is checked against the address rather than a name.
 *
 * Validity is irrelevant to the gateway here (it is told to skip verification
 * for 127.0.0.1), but issuing a correct cert keeps the stub honest for anything
 * that does verify.
 */
const selfSignedCert = (): { key: string; cert: string; dir: string } => {
  const dir = mkdtempSync(join(tmpdir(), "onecli-e2e-tls-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    // openssl narrates key generation on stderr; keep the test output readable.
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  return {
    key: readFileSync(keyPath, "utf8"),
    cert: readFileSync(certPath, "utf8"),
    dir,
  };
};

export interface StubOptions {
  /** Serve HTTPS. Required for anything reaching the gateway's MITM path,
   *  which always dials upstreams over TLS. */
  readonly tls?: boolean;
  /**
   * Accept WebSocket upgrades.
   *
   * Off by default, and deliberately so: with an `upgrade` listener attached,
   * Node routes an upgrade request away from the ordinary request handler. A
   * test asserting the gateway did NOT forward one would then see an empty
   * request list and fail as a timeout instead of an assertion.
   */
  readonly websocket?: boolean;
}

export const startStubUpstream = async (
  options: StubOptions = {},
): Promise<WebSocketStubUpstream> => {
  const received: RecordedRequest[] = [];
  let fallback: StubResponse = { status: 200, body: "{}" };
  let streamed: StubStream | undefined;
  const waiters = new Set<CountWaiter>();

  const writeStream = async (
    res: ServerResponse,
    stream: StubStream,
  ): Promise<void> => {
    res.writeHead(stream.status ?? 200, {
      "content-type": "text/event-stream",
      ...stream.headers,
    });
    for (const [i, chunk] of stream.chunks.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, stream.gapMs));
      // Teardown calls closeAllConnections(), which can destroy this response
      // mid-gap; writing to it then throws.
      if (res.destroyed) return;
      res.write(chunk);
    }
    res.end();
  };

  const writeFallback = async (
    res: ServerResponse,
    response: StubResponse,
  ): Promise<void> => {
    if (response.delayMs !== undefined) {
      await new Promise((r) => setTimeout(r, response.delayMs));
      // Teardown's closeAllConnections() can destroy the response mid-delay.
      if (res.destroyed) return;
    }
    res.writeHead(response.status ?? 200, {
      "content-type": "application/json",
      ...response.headers,
    });
    res.end(response.body ?? "{}");
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push(record(req, Buffer.concat(chunks).toString("utf8")));
      for (const w of waiters) {
        if (received.length >= w.count) {
          waiters.delete(w);
          w.resolve();
        }
      }
      if (streamed !== undefined) {
        // An explicit catch, not a bare `void`: a rejection here would surface
        // as an unhandled rejection attributed to whichever test happens to be
        // running when teardown races the write.
        void writeStream(res, streamed).catch(() => undefined);
        return;
      }
      void writeFallback(res, fallback).catch(() => undefined);
    });
  };

  const tls = options.tls === true ? selfSignedCert() : undefined;
  const server: Server =
    tls === undefined
      ? createServer(handle)
      : createTlsServer({ key: tls.key, cert: tls.cert }, handle);

  // ── WebSocket upgrades ────────────────────────────────────────────────
  const upgraded: RecordedUpgrade[] = [];
  const upgradeSockets: Duplex[] = [];
  const upgradeWaiters = new Set<CountWaiter>();
  let upgradeResponse: StubUpgradeResponse = {};

  if (options.websocket === true) {
    server.on(
      "upgrade",
      (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        upgradeSockets.push(socket);
        // The peer going away is the expected end of this socket; an unhandled
        // error event would take the whole test worker down with it.
        socket.on("error", () => undefined);

        const headers = flattenHeaders(req.headers);

        // Seeded with `head`, not "": any client bytes that shared a TCP segment
        // with the upgrade request are delivered ONLY here, and are never seen
        // by the socket's `data` events. Today's tests send after awaiting the
        // 101 so it is always empty — but dropping it would make `received()`
        // silently lose the first payload the day anything coalesces.
        let inbound = head.toString("utf8");
        socket.on("data", (chunk: Buffer) => {
          inbound += chunk.toString("utf8");
        });

        // Recorded before the response is written, so a test that awaits the
        // handshake can read upgrades() without racing it.
        upgraded.push({
          method: req.method ?? "GET",
          url: req.url ?? "/",
          headers,
          rawHeaders: [...req.rawHeaders],
          header: (name: string) => headers[name.toLowerCase()],
          received: () => inbound,
        });
        for (const w of upgradeWaiters) {
          if (upgraded.length >= w.count) {
            upgradeWaiters.delete(w);
            w.resolve();
          }
        }

        const extra = Object.entries(upgradeResponse.headers ?? {})
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join("");
        const status = upgradeResponse.status ?? 101;

        if (status === 101) {
          const accept = websocketAccept(headers["sec-websocket-key"] ?? "");
          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\n" +
              "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
              `Sec-WebSocket-Accept: ${accept}\r\n${extra}\r\n`,
          );
          return;
        }

        // A refusal. hyper reads this as an ordinary response, which is what
        // sends the gateway down its passthrough path.
        const body = upgradeResponse.body ?? "";
        socket.write(
          `HTTP/1.1 ${String(status)} Upgrade Refused\r\n` +
            `content-length: ${String(Buffer.byteLength(body))}\r\n` +
            `${extra}\r\n${body}`,
        );
        socket.end();
      },
    );
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(
      `stub upstream bound to an unexpected address: ${String(address)}`,
    );
  }
  const port = address.port;
  const authority = `127.0.0.1:${String(port)}`;
  const scheme = tls === undefined ? "http" : "https";

  return {
    host: "127.0.0.1",
    port,
    authority,
    url: (path: string) =>
      `${scheme}://${authority}${path.startsWith("/") ? path : `/${path}`}`,
    respond: (response: StubResponse) => {
      fallback = response;
      // Cleared, because `handle` checks the stream first: leaving it set would
      // make every later respond() on this stub silently do nothing.
      streamed = undefined;
    },
    respondStream: (stream: StubStream) => {
      streamed = stream;
    },
    requests: () => received,
    waitForRequests: (count, timeoutMs) =>
      waitForCount(received, waiters, count, "request", timeoutMs),
    respondUpgrade: (response: StubUpgradeResponse) => {
      upgradeResponse = response;
    },
    upgrades: () => upgraded,
    waitForUpgrades: (count, timeoutMs) =>
      waitForCount(upgraded, upgradeWaiters, count, "upgrade", timeoutMs),
    sendToClient: (text: string, index = 0) => {
      const socket = upgradeSockets[index];
      if (socket === undefined) {
        throw new Error(
          `no upgraded socket at index ${String(index)} (have ${String(upgradeSockets.length)})`,
        );
      }
      socket.write(text);
    },
    close: () =>
      new Promise<void>((resolve) => {
        // Upgraded sockets are detached from the server, so closeAllConnections
        // does not reach them — and one left alive means the close callback
        // below never fires, hanging the scenario that awaits it.
        for (const socket of upgradeSockets) socket.destroy();
        // The gateway's client keeps connections alive, so close() alone would
        // wait on them indefinitely.
        server.closeAllConnections();
        server.close(() => {
          try {
            if (tls !== undefined)
              rmSync(tls.dir, { recursive: true, force: true });
          } finally {
            // resolve() must run even if the cleanup above throws: this
            // promise is awaited during teardown, and leaving it pending
            // would hang the scenario and strand its database.
            resolve();
          }
        });
      }),
  };
};
