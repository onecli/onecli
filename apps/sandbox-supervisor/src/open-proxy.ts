import { rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import { log } from "./log";

/**
 * The open proxy: a loopback forward proxy that puts a client on the
 * gateway's OPEN lane.
 *
 * The sandbox's egress is the gateway, and the gateway has two lanes. The
 * default (what HTTPS_PROXY points at) terminates TLS, injects stored
 * credentials and inspects every request. The open lane (proxy username
 * `open`) relays the client's bytes untouched, so the origin sees the
 * client's own TLS. A browser needs the open lane: bot defences refuse a
 * re-signed session, and a browser never trusts the gateway's certificate
 * for a site it did not expect.
 *
 * Browsers cannot send proxy credentials from a URL (Chromium reads the host
 * out of HTTPS_PROXY and never the userinfo), so this process sits between
 * them and the gateway. It accepts an unauthenticated CONNECT on
 * 127.0.0.1, re-issues it to the gateway as `open:<agent token>`, and from
 * the gateway's 200 on is a byte pump. Nothing else:
 *
 * - CONNECT only. An absolute-form request (`GET http://host/`) is refused
 *   with 405, so this listener can never be mistaken for, or used as, the
 *   credential-injecting proxy.
 * - The gateway's answer is forwarded verbatim. A blocked host, a private
 *   address, or a rejected token reaches the browser as the gateway's own
 *   403/407 (Chromium shows ERR_TUNNEL_CONNECTION_FAILED), never as a
 *   silent hang.
 * - No authentication of its own, by design. It listens on loopback inside
 *   the sandbox, where every process already runs as the same uid with the
 *   token in its environment; and the open lane is the LESS privileged lane
 *   (no injection), so a caller gains nothing here it could not get by
 *   sending `open:<token>` itself. The security boundary stays the gateway,
 *   which authenticates the token and enforces host policy and the
 *   destination guard on every CONNECT.
 *
 * The token is read from HTTPS_PROXY once at start and never logged (the
 * log layer redacts proxy URLs anyway).
 */

/** The username the gateway reads as "relay, do not terminate". */
export const OPEN_LANE_USER = "open";

/**
 * The port tried first: the conventional forward-proxy port, so an agent
 * reading `$OPEN_PROXY` sees something it recognizes. Not reserved: if it
 * is taken (the agent installed Squid), the next free port is used and
 * `OPEN_PROXY` carries whatever was bound. Instructions cite the variable,
 * never the number.
 */
export const OPEN_PROXY_PORT = 3128;

/** How many consecutive ports to try after the preferred one before giving up. */
const PORT_ATTEMPTS = 10;

/**
 * Bound on reaching the gateway and reading its CONNECT reply. A browser
 * waiting on a tunnel that never answers shows nothing for minutes; a
 * refused connect shows a proxy error at once. The gateway bounds its own
 * upstream dial the same way.
 */
const GATEWAY_REPLY_TIMEOUT_MS = 15_000;

export interface GatewayTarget {
  readonly host: string;
  readonly port: number;
  readonly token: string;
}

/**
 * The gateway host/port and the agent token, from the sandbox's proxy URL.
 * `undefined` when the URL is absent or carries no credential: there is no
 * gateway to reach, so the open proxy does not start (local dev without a
 * gateway, or a misconfigured spawn, which the supervisor reports anyway).
 */
export const gatewayFromProxyUrl = (
  proxyUrl: string | undefined,
): GatewayTarget | undefined => {
  if (!proxyUrl) return undefined;
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    return undefined;
  }
  // The token rides in the password field (`x:<token>`), or, in the legacy
  // shape, in the username (`<token>:`). Same reading as the gateway's.
  const token = decodeURIComponent(url.password || url.username);
  if (!url.hostname || !token) return undefined;
  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : 80;
  return { host: url.hostname, port, token };
};

const basic = (user: string, token: string): string =>
  `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;

const HEAD_END = "\r\n\r\n";

/**
 * Open one tunnel on the gateway's open lane and splice the client into it.
 *
 * The gateway's reply head is read and judged BEFORE anything is piped:
 * a 200 becomes the client's 200 and the two sockets are joined; anything
 * else is written to the client as-is and both sides are closed.
 */
const tunnel = (
  gateway: GatewayTarget,
  authority: string,
  client: Duplex,
  head: Buffer,
  replyTimeoutMs: number,
): void => {
  const upstream: Socket = connect(gateway.port, gateway.host);
  let buffered = Buffer.alloc(0);

  const fail = (): void => {
    if (!client.destroyed) client.destroy();
    upstream.destroy();
  };

  // Covers the dial AND the reply head; cleared once the gateway has
  // answered, because from then on the tunnel is the client's to keep open.
  const replyTimer = setTimeout(() => {
    if (!client.destroyed) {
      client.end("HTTP/1.1 504 Gateway Timeout\r\ncontent-length: 0\r\n\r\n");
    }
    upstream.destroy();
  }, replyTimeoutMs);

  const onReply = (chunk: Buffer): void => {
    buffered = Buffer.concat([buffered, chunk]);
    const split = buffered.indexOf(HEAD_END);
    if (split === -1) return;
    clearTimeout(replyTimer);
    upstream.removeListener("data", onReply);

    const reply = buffered.subarray(0, split).toString("latin1");
    const status = Number(reply.split("\r\n")[0]?.split(" ")[1]);
    const rest = buffered.subarray(split + HEAD_END.length);

    if (status !== 200) {
      // The gateway's refusal, verbatim: status line, headers and whatever
      // body already arrived. The browser reads a proxy error, not a
      // timeout, and the reason is in the body for anyone who looks.
      client.end(buffered);
      upstream.destroy();
      return;
    }

    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    // Bytes the client sent along with its CONNECT (a TLS ClientHello that
    // shared the segment) go up first; bytes the origin sent before our
    // head parse finished go down first. Then the pumps take over.
    if (head.length > 0) upstream.write(head);
    if (rest.length > 0) client.write(rest);
    client.pipe(upstream);
    upstream.pipe(client);
  };

  upstream.once("connect", () => {
    upstream.write(
      `CONNECT ${authority} HTTP/1.1\r\n` +
        `Host: ${authority}\r\n` +
        `Proxy-Authorization: ${basic(OPEN_LANE_USER, gateway.token)}\r\n\r\n`,
    );
    upstream.on("data", onReply);
  });
  upstream.on("error", fail);
  client.on("error", fail);
  // Either side closing takes the other with it; a half-open tunnel is a
  // leaked socket in a process that lives as long as the sandbox.
  upstream.on("close", () => {
    clearTimeout(replyTimer);
    if (!client.destroyed) client.destroy();
  });
  client.on("close", () => {
    clearTimeout(replyTimer);
    upstream.destroy();
  });
};

export interface OpenProxy {
  /** `http://127.0.0.1:<port>`, what `OPEN_PROXY` carries. */
  readonly url: string;
  readonly port: number;
  close(): void;
}

/**
 * Where the bound URL is published for sessions that do not inherit the
 * supervisor's environment. The harness and its children get `OPEN_PROXY`
 * from `process.env`; an SSH session is a fresh exec into the container that
 * sees only the container env plus `/etc/profile.d`, so the image's profile
 * drop-in reads this file. One line, the URL, boot-owned (rewritten every start,
 * never read back by this process).
 */
export const OPEN_PROXY_URL_FILE = "/tmp/onecli-open-proxy.url";

export const publishOpenProxyUrl = (url: string): void => {
  try {
    // Unlink first, then write a fresh regular file: a path under /tmp is
    // writable by anything in the container, and writing THROUGH a planted
    // symlink would land the URL wherever that symlink points. `rmSync`
    // removes a symlink itself rather than following it.
    rmSync(OPEN_PROXY_URL_FILE, { force: true });
    writeFileSync(OPEN_PROXY_URL_FILE, `${url}\n`, { mode: 0o644, flag: "wx" });
  } catch (error) {
    // Best-effort: the harness still has the env; only the SSH door loses
    // the shortcut, and it can read `OPEN_PROXY` from `/proc/1/environ`.
    log("warn", "open proxy: could not publish the URL file", {
      path: OPEN_PROXY_URL_FILE,
      error: String(error),
    });
  }
};

const listenOn = (server: Server, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });

/**
 * Start the open proxy on loopback. Tries `preferredPort` first and walks up
 * when it is taken; throws only when every attempt fails.
 */
export const startOpenProxy = async (
  gateway: GatewayTarget,
  preferredPort = OPEN_PROXY_PORT,
  replyTimeoutMs = GATEWAY_REPLY_TIMEOUT_MS,
): Promise<OpenProxy> => {
  const server = createServer((req: IncomingMessage, res) => {
    // Not a credential-injecting proxy, and never mistakable for one: a
    // plain request has no tunnel to ride, so there is nothing here for it.
    res.writeHead(405, { allow: "CONNECT", "content-type": "text/plain" });
    res.end(
      "open proxy: CONNECT only. API calls use the gateway proxy in HTTPS_PROXY.\n",
    );
  });
  server.on("connect", (req, socket, head) => {
    const authority = req.url ?? "";
    // The authority is handed to the gateway as-is; the gateway resolves and
    // judges it. Only the shape is checked here: a bare host:port, so a
    // target that is a URL, a path, or anything with whitespace never
    // becomes part of the upstream CONNECT line.
    if (!/^[A-Za-z0-9.\-[\]:_]+$/.test(authority)) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    tunnel(gateway, authority, socket, head, replyTimeoutMs);
  });
  // Clients are browsers that keep connections open; the proxy must never be
  // what keeps a finished supervisor alive.
  server.unref();

  let lastError: unknown;
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    const port = preferredPort + attempt;
    try {
      const bound = await listenOn(server, port);
      if (attempt > 0) {
        log(
          "warn",
          "open proxy: preferred port taken, using the next free one",
          {
            preferred: preferredPort,
            port: bound,
          },
        );
      }
      return {
        url: `http://127.0.0.1:${String(bound)}`,
        port: bound,
        close: () => {
          server.close();
          server.closeAllConnections();
        },
      };
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" && code !== "EACCES") throw error;
    }
  }
  throw new Error(
    `open proxy: no free port in ${String(preferredPort)}..${String(preferredPort + PORT_ATTEMPTS - 1)}: ${String(lastError)}`,
  );
};
