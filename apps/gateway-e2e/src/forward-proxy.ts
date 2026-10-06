import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

import { flattenHeaders } from "./http.js";

/**
 * An outbound forward proxy the gateway is pointed at with `HTTP_PROXY` /
 * `HTTPS_PROXY`, recording what the gateway sends on to the internet.
 *
 * It exists for the one thing the stub upstream cannot show: traffic to a REAL
 * provider host. The gateway's credential injection and its OAuth refreshes
 * target fixed provider hostnames (`gitlab.com`), which no test can redirect
 * to a local stub. Every outbound HTTP client the gateway builds honors the
 * standard proxy variables, though, so routing it through here makes those
 * calls observable without any network egress:
 *
 * - an `https://` call (a token refresh) arrives as `CONNECT host:443`. Only
 *   the attempt is visible (the tunnel is refused, never opened), which is
 *   exactly enough to count how many times a refresh token was presented.
 * - an `http://` request arrives in absolute form, headers and all, so the
 *   credential the gateway injected is readable.
 *
 * Binds `127.0.0.1` (see the stub upstream for why never `localhost`).
 */
export interface ProxiedRequest {
  readonly method: string;
  /** Absolute-form target, e.g. `http://gitlab.com/api/v4/user`. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  header(name: string): string | undefined;
}

export interface ForwardProxyOptions {
  /**
   * Hold each CONNECT this long before refusing it. This is the window in
   * which the call is genuinely in flight from the gateway's point of view,
   * which is what makes concurrent attempts overlap.
   */
  readonly connectHoldMs?: number;
  /**
   * Run when a CONNECT arrives, before the hold starts. Awaited, so whatever
   * it does has landed before the gateway sees the refusal.
   */
  readonly onConnect?: (authority: string) => Promise<void>;
}

export interface ForwardProxy {
  /** `http://127.0.0.1:<port>`, the value for `HTTP_PROXY` / `HTTPS_PROXY`. */
  readonly url: string;
  /** Every CONNECT authority, in arrival order. */
  connects(): ReadonlyArray<string>;
  /** Every plain proxied request, in arrival order. */
  requests(): ReadonlyArray<ProxiedRequest>;
  close(): Promise<void>;
}

export const startForwardProxy = async (
  options: ForwardProxyOptions = {},
): Promise<ForwardProxy> => {
  const connects: string[] = [];
  const requests: ProxiedRequest[] = [];
  const sockets = new Set<Duplex>();

  const server: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const headers = flattenHeaders(req.headers);
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers,
        header: (name: string) => headers[name.toLowerCase()],
      });
      // Drain the body, then answer like a healthy upstream.
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    },
  );

  server.on("connect", (req: IncomingMessage, socket: Duplex) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // The gateway giving up on its side is an expected end of this socket.
    socket.on("error", () => undefined);
    const authority = req.url ?? "";
    connects.push(authority);

    const refuse = async (): Promise<void> => {
      await options.onConnect?.(authority);
      await new Promise((r) => setTimeout(r, options.connectHoldMs ?? 0));
      if (socket.destroyed) return;
      socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
    };
    void refuse().catch(() => socket.destroy());
  });

  server.on("connection", (socket: Duplex) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("forward proxy did not bind a TCP port");
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    connects: () => connects,
    requests: () => requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
