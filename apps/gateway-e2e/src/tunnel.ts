import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

import {
  makeResponse,
  parseHeaderLines,
  parseStatusLine,
  type HttpResponse,
} from "./http.js";

/**
 * Drive the gateway's open tunnel lane the way a browser's proxy client does:
 * a `CONNECT` whose proxy username is `open`, then the client's OWN TLS
 * inside it, against the origin's certificate, with no gateway CA anywhere
 * in the chain.
 *
 * Hand-rolled on a raw socket for the same reason the WebSocket client is:
 * the thing under test is what the gateway puts on the wire before, and
 * instead of, the 200: a refusal has to be readable, and `undici` would
 * swallow it as a connect error. The username is a parameter, not a
 * constant, so a test can prove that the lane is selected by exactly `open`
 * and by nothing else.
 */

/** `Basic base64("<user>:<token>")` with an explicit username. */
export const proxyAuthHeaderAs = (user: string, token: string): string =>
  `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;

const HEAD_END = "\r\n\r\n";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface TunnelOptions {
  /** e.g. `127.0.0.1:<port>`. Named in the CONNECT line, never resolved here. */
  readonly authority: string;
  /** Proxy username. `open` selects the tunnel lane; anything else the MITM lane. */
  readonly user: string;
  /** Agent token (the password field). Omitted means an untokened CONNECT. */
  readonly token?: string;
  readonly timeoutMs?: number;
}

/** A tunnel the gateway opened (200), as a raw socket the test can speak on. */
export interface OpenTunnel {
  readonly socket: Socket;
  /**
   * Complete a TLS handshake inside the tunnel against `ca` (the ORIGIN's
   * certificate, not the gateway's) and return the TLS socket.
   */
  tls(options: { ca: string; servername?: string }): Promise<TLSSocket>;
  close(): void;
}

export type TunnelResult =
  | { readonly kind: "open"; readonly tunnel: OpenTunnel }
  /** The gateway's answer to the CONNECT, read to completion. */
  | { readonly kind: "refused"; readonly reply: HttpResponse };

/**
 * Issue the CONNECT and read the gateway's reply. A 200 hands the socket
 * back, still open, with anything already read past the head pushed back so
 * the TLS layer sees every byte; anything else is read to completion (it has
 * a `content-length`) and returned as the refusal.
 */
export const connectTunnel = (
  gatewayOrigin: string,
  options: TunnelOptions,
): Promise<TunnelResult> => {
  const gateway = new URL(gatewayOrigin);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<TunnelResult>((resolve, reject) => {
    const socket = netConnect(Number(gateway.port), gateway.hostname, () => {
      const auth =
        options.token === undefined
          ? ""
          : `Proxy-Authorization: ${proxyAuthHeaderAs(options.user, options.token)}\r\n`;
      socket.write(
        `CONNECT ${options.authority} HTTP/1.1\r\nHost: ${options.authority}\r\n${auth}\r\n`,
      );
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy(new Error(`CONNECT ${options.authority} timed out`));
    });

    let buffered = Buffer.alloc(0);
    let head: { status: number; headers: Record<string, string> } | undefined;

    const finishRefusal = (): void => {
      if (head === undefined) return;
      const split = buffered.indexOf(HEAD_END);
      const body = buffered.subarray(split + HEAD_END.length).toString("utf8");
      socket.destroy();
      resolve({
        kind: "refused",
        reply: makeResponse(head.status, head.headers, body),
      });
    };

    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (head === undefined) {
        const split = buffered.indexOf(HEAD_END);
        if (split === -1) return;
        const [statusLine = "", ...rest] = buffered
          .subarray(0, split)
          .toString("utf8")
          .split("\r\n");
        head = {
          status: parseStatusLine(statusLine),
          headers: parseHeaderLines(rest),
        };
        if (head.status === 200) {
          // The tunnel is open. Stop reading here, push back whatever the
          // origin may already have sent, and hand the socket over paused
          // so no byte is lost between this listener and the TLS layer.
          socket.removeListener("data", onData);
          const rest = buffered.subarray(split + HEAD_END.length);
          if (rest.length > 0) socket.unshift(rest);
          socket.pause();
          socket.setTimeout(0);
          resolve({ kind: "open", tunnel: openTunnel(socket, timeoutMs) });
          return;
        }
      }
      // A refusal: every gateway refusal carries a content-length.
      const split = buffered.indexOf(HEAD_END);
      const have = buffered.length - (split + HEAD_END.length);
      const want = Number(head.headers["content-length"] ?? "0");
      if (have >= want) finishRefusal();
    };
    socket.on("data", onData);
    socket.on("end", () => {
      // Hung up without a reply, or before the body was complete.
      if (head === undefined) {
        reject(new Error("gateway closed the connection without a reply"));
        return;
      }
      finishRefusal();
    });
    socket.on("error", reject);
  });
};

const openTunnel = (socket: Socket, timeoutMs: number): OpenTunnel => ({
  socket,
  tls: ({ ca, servername }) =>
    new Promise<TLSSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        tls.destroy();
        reject(new Error("TLS handshake inside the tunnel timed out"));
      }, timeoutMs);
      const tls = tlsConnect(
        {
          socket,
          // The ORIGIN's CA replaces Node's roots: only the origin's own
          // certificate can verify. A gateway that terminated TLS would
          // present its minted leaf and fail this handshake, which is the
          // whole point of the lane.
          ca,
          ...(servername === undefined ? {} : { servername }),
        },
        () => {
          clearTimeout(timer);
          resolve(tls);
        },
      );
      tls.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    }),
  close: () => socket.destroy(),
});

/**
 * Decode a complete `Transfer-Encoding: chunked` body. Node's `https` server
 * frames every response without a known length this way, so a raw reader
 * that returned the frame as-is would hand a test `b\r\n{...}\r\n0\r\n\r\n`
 * where it expected JSON.
 */
const dechunk = (raw: Buffer): string => {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = raw.indexOf("\r\n", at);
    if (lineEnd === -1) break;
    const size = Number.parseInt(
      raw.subarray(at, lineEnd).toString("ascii"),
      16,
    );
    if (Number.isNaN(size) || size === 0) break;
    const start = lineEnd + 2;
    parts.push(raw.subarray(start, start + size));
    at = start + size + 2; // skip the chunk's trailing CRLF
  }
  return Buffer.concat(parts).toString("utf8");
};

/** Read a whole HTTP/1.1 response off a TLS socket: by content-length, chunked framing, or close. */
export const readHttpResponse = (
  tls: TLSSocket,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HttpResponse> =>
  new Promise<HttpResponse>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("no complete response inside the tunnel"));
    }, timeoutMs);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const split = buffered.indexOf(HEAD_END);
      const headEnd = split === -1 ? buffered.length : split;
      const [statusLine = "", ...rest] = buffered
        .subarray(0, headEnd)
        .toString("utf8")
        .split("\r\n");
      const headers = parseHeaderLines(rest);
      const rawBody =
        split === -1
          ? Buffer.alloc(0)
          : buffered.subarray(split + HEAD_END.length);
      const body =
        headers["transfer-encoding"]?.includes("chunked") === true
          ? dechunk(rawBody)
          : rawBody.toString("utf8");
      resolve(makeResponse(parseStatusLine(statusLine), headers, body));
    };
    tls.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const split = buffered.indexOf(HEAD_END);
      if (split === -1) return;
      const headers = parseHeaderLines(
        buffered.subarray(0, split).toString("utf8").split("\r\n").slice(1),
      );
      const bodyBytes = buffered.length - (split + HEAD_END.length);
      const length = headers["content-length"];
      if (length !== undefined) {
        if (bodyBytes >= Number(length)) finish();
        return;
      }
      if (
        headers["transfer-encoding"]?.includes("chunked") === true &&
        buffered.includes("\r\n0\r\n\r\n")
      ) {
        finish();
      }
      // Otherwise delimited by close; `end` settles it.
    });
    tls.on("end", finish);
    tls.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
