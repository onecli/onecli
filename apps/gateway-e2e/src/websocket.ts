import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

import {
  makeResponse,
  parseHeaderLines,
  parseStatusLine,
  type HttpResponse,
} from "./http.js";
import { proxyAuthHeader } from "./proxy.js";

/**
 * Attempt a WebSocket upgrade through the gateway's MITM path.
 *
 * Hand-rolled on a raw socket because there is no alternative: `undici` rejects
 * both `Upgrade` and `Connection` as forbidden request headers, and a real
 * WebSocket client would swallow the very thing these tests exist to read — the
 * non-101 response the gateway sends when policy refuses the upgrade.
 *
 * The upgrade is only reachable through `CONNECT`; the absolute-form proxy path
 * has no upgrade detection at all, so a WS request there is forwarded as
 * ordinary HTTP.
 *
 * For the policy arms, the authority never has to resolve: the client dials
 * only the gateway and names the target in the CONNECT line, so an arm that
 * answers before any upstream socket is opened costs no DNS and no egress.
 * A test that wants a real session names the local stub instead.
 */
/**
 * What both clients need to dial.
 *
 * Split into three rather than one bag because each client reads only its own
 * extra field. Sharing one type would let a test pass an option the client it
 * called silently ignores — a green run asserting nothing, which is the exact
 * failure this suite exists to make impossible.
 */
export interface WebSocketDialOptions {
  /** e.g. `gmail.googleapis.com:443`. Never resolved by the client. */
  readonly authority: string;
  readonly path: string;
  /** Required: the gateway refuses an untokened CONNECT outright. */
  readonly token: string;
  /** The gateway's CA, from its data dir. */
  readonly caPath: string;
  readonly timeoutMs?: number;
}

/** A one-shot attempt: read one response, hang up. */
export interface WebSocketUpgradeOptions extends WebSocketDialOptions {
  /** Omit the upgrade headers, to prove the routing is gated on them. */
  readonly withUpgradeHeaders?: boolean;
}

/** A live session, kept open so bytes can be pushed through it. */
export interface OpenWebSocketOptions extends WebSocketDialOptions {
  /** Extra request headers, to observe which ones the gateway forwards. */
  readonly headers?: Readonly<Record<string, string>>;
}

const HEAD_END = "\r\n\r\n";

const DEFAULT_TIMEOUT_MS = 15_000;

/** A `receive` still waiting on bytes that have not arrived yet. */
interface PendingRead {
  /** Consume the bytes if the terminator is present; false if not yet. */
  take(): boolean;
  fail(error: Error): void;
}

/** A CONNECT tunnel to the gateway, with everything the handshake needs. */
interface DialedTunnel {
  readonly tunnel: Socket;
  readonly hostname: string;
  readonly ca: string;
  readonly timeoutMs: number;
}

const openTunnel = (
  gatewayOrigin: string,
  authority: string,
  token: string,
  timeoutMs: number,
): Promise<Socket> => {
  const gateway = new URL(gatewayOrigin);
  return new Promise<Socket>((resolve, reject) => {
    const socket = netConnect(Number(gateway.port), gateway.hostname, () => {
      const auth = `Proxy-Authorization: ${proxyAuthHeader(token)}\r\n`;
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`,
      );
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy(new Error(`CONNECT ${authority} timed out`));
    });

    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const split = buffered.indexOf(HEAD_END);
      if (split === -1) return;
      socket.removeListener("data", onData);

      const head = buffered.subarray(0, split).toString("utf8");
      const status = parseStatusLine(head.split("\r\n")[0] ?? "");
      if (status !== 200) {
        socket.destroy();
        reject(new Error(`CONNECT refused with ${String(status)}`));
        return;
      }
      // Removing the listener does NOT pause the socket — it stays in flowing
      // mode and any byte arriving before the TLS layer attaches would be read
      // and dropped. Pause until `tlsConnect` takes it over, and hand back
      // anything already read past the head.
      const rest = buffered.subarray(split + HEAD_END.length);
      if (rest.length > 0) socket.unshift(rest);
      socket.pause();
      socket.setTimeout(0);
      resolve(socket);
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
};

/**
 * Resolve the dial parameters and open the CONNECT tunnel.
 *
 * The CA is read BEFORE the tunnel exists, deliberately: doing it inline as a
 * `tlsConnect` argument means a missing CA throws with the tunnel already open
 * and its idle timeout already cleared, leaking a socket nothing can close.
 * Shared by both clients so that ordering — and the reason for it — cannot
 * drift apart the way a copied prologue does.
 */
const dialTunnel = async (
  gatewayOrigin: string,
  options: WebSocketDialOptions,
): Promise<DialedTunnel> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const hostname = options.authority.split(":")[0] ?? options.authority;
  const ca = readFileSync(options.caPath, "utf8");
  const tunnel = await openTunnel(
    gatewayOrigin,
    options.authority,
    options.token,
    timeoutMs,
  );
  return { tunnel, hostname, ca, timeoutMs };
};

/**
 * Is the response complete?
 *
 * Deliberately explicit about each framing rather than defaulting a missing
 * `content-length` to zero: that default reads as "complete" the instant the
 * head arrives, so the body would come back empty and every body assertion
 * would pass vacuously. A harness that silently under-reads is worse than one
 * that hangs.
 */
const responseComplete = (
  buffered: Buffer,
  split: number,
  status: number,
  headers: Readonly<Record<string, string>>,
): boolean => {
  // A 101 has no body and the socket then stays open for frames, so waiting
  // for an end that never comes would hang.
  if (status === 101) return true;

  const contentLength = headers["content-length"];
  if (contentLength !== undefined) {
    // Compared in BYTES. `buffered.length` on a string would be UTF-16 code
    // units, so a body with any non-ASCII character — a rule name, say, which
    // comes straight from a fixture — would never satisfy this and the request
    // would hang until the timeout, hiding the real response.
    const body = buffered.length - (split + HEAD_END.length);
    return body >= Number(contentLength);
  }

  if (headers["transfer-encoding"]?.includes("chunked") === true) {
    return buffered.includes("\r\n0\r\n\r\n");
  }

  // Delimited by the connection closing; `end` settles it.
  return false;
};

/** A WebSocket session the gateway has established end to end. */
export interface WebSocketSession {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  header(name: string): string | undefined;
  /** The key this client generated, so a test can verify the accept hash. */
  readonly key: string;
  send(text: string): void;
  /**
   * Read until `terminator` arrives.
   *
   * To a terminator, never a byte count: TCP will split even a short sentinel
   * across two `data` events often enough to matter.
   */
  receive(terminator: string, timeoutMs?: number): Promise<string>;
  close(): void;
}

/**
 * Establish a WebSocket through the gateway and keep it open.
 *
 * The counterpart to [`websocketUpgrade`], which reads one response and hangs
 * up. This one hands back the live pipe, so a test can prove bytes actually
 * traverse it in both directions.
 */
export const openWebSocket = async (
  gatewayOrigin: string,
  options: OpenWebSocketOptions,
): Promise<WebSocketSession> => {
  const key = randomBytes(16).toString("base64");
  const { tunnel, hostname, ca, timeoutMs } = await dialTunnel(
    gatewayOrigin,
    options,
  );

  return new Promise<WebSocketSession>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const tls = tlsConnect(
        { socket: tunnel, servername: hostname, ca },
        () => {
          tls.write(
            `GET ${options.path} HTTP/1.1\r\nHost: ${hostname}\r\n` +
              `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
              `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
              Object.entries(options.headers ?? {})
                .map(([k, v]) => `${k}: ${v}\r\n`)
                .join("") +
              "\r\n",
          );
        },
      );

      timer = setTimeout(() => {
        tls.destroy();
        reject(new Error(`WebSocket to ${options.authority} timed out`));
      }, timeoutMs);

      // Bytes that arrive after the handshake head, waiting to be read.
      let body = "";
      let head: { status: number; headers: Record<string, string> } | undefined;

      // A set rather than a single slot: two overlapping reads would otherwise
      // orphan the first one, and a socket that dies with a read outstanding
      // has to reject every waiter here and now — left alone, the rejection
      // lands after the test that started it has finished, and vitest blames
      // whichever test is running by then.
      const waiters = new Set<PendingRead>();
      const pump = (): void => {
        for (const waiter of [...waiters]) {
          if (waiter.take()) waiters.delete(waiter);
        }
      };
      const failAll = (error: Error): void => {
        for (const waiter of [...waiters]) waiter.fail(error);
        waiters.clear();
      };

      let buffered = Buffer.alloc(0);
      tls.on("data", (chunk: Buffer) => {
        if (head === undefined) {
          buffered = Buffer.concat([buffered, chunk]);
          const split = buffered.indexOf(HEAD_END);
          if (split === -1) return;
          const [statusLine = "", ...rest] = buffered
            .subarray(0, split)
            .toString("utf8")
            .split("\r\n");
          // Captured, not read back off the outer `let`: TS resets narrowing
          // inside the closures below, and `head?.` there would suppress that
          // rather than prove it cannot be undefined.
          const resolved = {
            status: parseStatusLine(statusLine),
            headers: parseHeaderLines(rest),
          };
          head = resolved;
          body += buffered.subarray(split + HEAD_END.length).toString("utf8");
          buffered = Buffer.alloc(0);
          clearTimeout(timer);
          resolve({
            status: resolved.status,
            headers: resolved.headers,
            header: (name: string) => resolved.headers[name.toLowerCase()],
            key,
            // A block body, so discarding `write`'s backpressure signal is
            // deliberate rather than an accident of the concise form.
            send: (text: string) => {
              tls.write(text);
            },
            receive: (terminator: string, timeoutMs = 5_000) =>
              new Promise<string>((res, rej) => {
                const waiter: PendingRead = {
                  take: () => {
                    const at = body.indexOf(terminator);
                    if (at === -1) return false;
                    const taken = body.slice(0, at + terminator.length);
                    body = body.slice(at + terminator.length);
                    clearTimeout(deadline);
                    res(taken);
                    return true;
                  },
                  fail: (error: Error) => {
                    clearTimeout(deadline);
                    rej(error);
                  },
                };
                const deadline = setTimeout(() => {
                  waiters.delete(waiter);
                  rej(
                    new Error(
                      `no ${JSON.stringify(terminator)} within ${String(timeoutMs)}ms (have ${JSON.stringify(body)})`,
                    ),
                  );
                }, timeoutMs);
                // Bytes that arrived with the handshake head are already in
                // `body`, so a read that can be satisfied now never registers.
                if (!waiter.take()) waiters.add(waiter);
              }),
            close: () => {
              failAll(new Error("socket closed while a read was pending"));
              tls.destroy();
            },
          });
          return;
        }
        body += chunk.toString("utf8");
        pump();
      });

      tls.on("end", () => {
        // A clean hangup with no response at all. Saying so beats waiting out
        // the timeout and blaming the clock, which is what this did before.
        if (head === undefined) {
          clearTimeout(timer);
          reject(
            new Error("gateway closed the tunnel without a WebSocket response"),
          );
          return;
        }
        failAll(new Error("socket ended while a read was pending"));
      });

      tls.on("error", (error) => {
        clearTimeout(timer);
        failAll(error);
        reject(error);
      });
    } catch (error) {
      clearTimeout(timer);
      tunnel.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
};

export const websocketUpgrade = async (
  gatewayOrigin: string,
  options: WebSocketUpgradeOptions,
): Promise<HttpResponse> => {
  const { tunnel, hostname, ca, timeoutMs } = await dialTunnel(
    gatewayOrigin,
    options,
  );

  return new Promise<HttpResponse>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const tls = tlsConnect(
        {
          socket: tunnel,
          servername: hostname,
          // The gateway's CA REPLACES the default roots, so the forged leaf it
          // mints for this hostname is the only certificate that can verify.
          ca,
        },
        () => {
          const upgrade =
            options.withUpgradeHeaders === false
              ? ""
              : `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
                `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n` +
                `Sec-WebSocket-Version: 13\r\n`;
          tls.write(
            `GET ${options.path} HTTP/1.1\r\nHost: ${hostname}\r\n${upgrade}\r\n`,
          );
        },
      );

      timer = setTimeout(() => {
        tls.destroy();
        reject(
          new Error(`WebSocket upgrade to ${options.authority} timed out`),
        );
      }, timeoutMs);

      // Accumulated as Buffers: decoding each chunk on arrival would turn any
      // multi-byte character split across a TCP segment into U+FFFD.
      let buffered = Buffer.alloc(0);
      const finish = (): void => {
        clearTimeout(timer);
        const split = buffered.indexOf(HEAD_END);
        const headEnd = split === -1 ? buffered.length : split;
        const [statusLine = "", ...rest] = buffered
          .subarray(0, headEnd)
          .toString("utf8")
          .split("\r\n");
        const body =
          split === -1
            ? ""
            : buffered.subarray(split + HEAD_END.length).toString("utf8");
        // Destroying the TLS socket cascades to the tunnel underneath it.
        tls.destroy();
        resolve(
          makeResponse(
            parseStatusLine(statusLine),
            parseHeaderLines(rest),
            body,
          ),
        );
      };

      tls.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        const split = buffered.indexOf(HEAD_END);
        if (split === -1) return;
        const [statusLine = "", ...rest] = buffered
          .subarray(0, split)
          .toString("utf8")
          .split("\r\n");
        const headers = parseHeaderLines(rest);
        if (
          responseComplete(
            buffered,
            split,
            parseStatusLine(statusLine),
            headers,
          )
        ) {
          finish();
        }
      });
      tls.on("end", () => {
        if (buffered.length > 0) {
          finish();
          return;
        }
        // The gateway hung up without answering. Reporting that plainly beats
        // waiting out the timeout and blaming the clock for it.
        clearTimeout(timer);
        reject(new Error("gateway closed the tunnel without a response"));
      });
      tls.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    } catch (error) {
      clearTimeout(timer);
      tunnel.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
};
