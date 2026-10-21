import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { log } from "./log";
import { PortOpenError, type PortHub } from "./port-hub";

/**
 * The runner's internal stream API for the preview relay (plans/sandbox-ports.md
 * §11.3). The relay is a separate service and the only component that
 * parses internet-originated HTTP; this endpoint gives it RAW byte streams to
 * guest ports and nothing else — no HTTP semantics, no share lookup, no
 * authz beyond "the caller is the relay". WHICH port a sandbox may expose is
 * decided by the control plane alone (the runner pulls it over its rnr_
 * channel) and enforced twice below this: the hub only dials what the
 * allowlist holds, and the supervisor refuses anything else.
 *
 * Wire: `GET /v1/sandboxes/:sandboxId/ports/:port/stream` with
 * `Upgrade: onecli-port-stream` + `Authorization: Bearer <token>`. On success
 * the runner answers `101 Switching Protocols` and the socket becomes the
 * byte stream (TCP-over-HTTP-Upgrade, the shape `kubectl port-forward` and
 * Docker's attach use). Failures answer a plain status with a machine-readable
 * `x-onecli-port-error` so the relay can render an honest page.
 *
 * Also: `PUT /v1/sandboxes/:sandboxId/ports/allow` (no body) asks the runner
 * to re-pull the allowlist from the control plane. Private port, meant to be
 * network-fenced so only the relay reaches it, and token-authenticated
 * regardless.
 */

export const PORT_STREAM_UPGRADE = "onecli-port-stream";

/**
 * How long an arm from the control plane is trusted before the next stream
 * open re-pulls it. A page load is many opens in a burst (every asset is one
 * stream), and each re-pull is a control-plane DB read, so they coalesce
 * within this window. The relay's explicit `PUT …/ports/allow` (sent when an
 * open is refused as `not_allowed`) always re-pulls, so a share made inside
 * the window still works on its first request.
 */
export const ALLOWLIST_FRESH_MS = 5_000;

const STREAM_PATH =
  /^\/v1\/sandboxes\/([A-Za-z0-9_-]{1,100})\/ports\/(\d{1,5})\/stream$/;
const ALLOW_PATH = /^\/v1\/sandboxes\/([A-Za-z0-9_-]{1,100})\/ports\/allow$/;

const statusForCode: Record<string, number> = {
  not_allowed: 403,
  not_listening: 502,
  limit: 429,
  duplicate: 500,
  failed: 502,
  no_sandbox: 503,
  timeout: 504,
};

export interface PortApiOptions {
  port: number;
  token: string;
  hub: Pick<PortHub, "open" | "setAllowed">;
  /** The control plane's answer for a sandbox's live shared ports: the only
   * thing the allowlist is ever armed from. */
  allowedPorts: (sandboxId: string) => Promise<number[]>;
  host?: string;
  /** Test seams. */
  allowlistFreshMs?: number;
  now?: () => number;
}

const authorized = (req: IncomingMessage, token: string) => {
  const got = Buffer.from(req.headers.authorization ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
};

export const startPortApi = async (options: PortApiOptions) => {
  const {
    port,
    token,
    hub,
    allowedPorts,
    host = "127.0.0.1",
    allowlistFreshMs = ALLOWLIST_FRESH_MS,
    now = Date.now,
  } = options;
  if (token.length < 32)
    throw new Error("port API token must be at least 32 chars");

  /** When each sandbox's allowlist was last armed from the control plane. */
  const armedAt = new Map<string, number>();
  const rearm = async (sandboxId: string) => {
    const ports = await allowedPorts(sandboxId);
    const delivered = hub.setAllowed(sandboxId, ports);
    if (delivered) armedAt.set(sandboxId, now());
    else armedAt.delete(sandboxId);
    return delivered;
  };

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }
    if (!authorized(req, token)) {
      res.writeHead(401).end();
      return;
    }
    const allow = ALLOW_PATH.exec(url);
    if (allow && req.method === "PUT") {
      // A REFRESH, not a write: the caller (the relay) cannot name ports.
      // The runner asks the control plane over its own rnr_ channel and arms
      // exactly that answer, so a relay compromise cannot widen what is
      // dialable. Any body is ignored. Never throttled: this is how a share
      // newer than the last arm becomes dialable right away.
      req.resume();
      rearm(allow[1]!)
        .then((delivered) => {
          res.writeHead(delivered ? 204 : 503).end();
        })
        .catch((error: unknown) => {
          log("warn", "allowlist refresh failed", { error: String(error) });
          res.writeHead(502).end();
        });
      return;
    }
    res.writeHead(404).end();
  });

  server.on("upgrade", (req, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const fail = (status: number, code: string) => {
      socket.end(
        `HTTP/1.1 ${status} Error\r\nx-onecli-port-error: ${code}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`,
      );
    };
    if (!authorized(req, token)) return fail(401, "unauthorized");
    if ((req.headers.upgrade ?? "").toLowerCase() !== PORT_STREAM_UPGRADE)
      return fail(400, "bad_upgrade");
    const m = STREAM_PATH.exec(req.url ?? "");
    if (!m) return fail(404, "not_found");
    const sandboxId = m[1]!;
    const guestPort = Number(m[2]);
    if (guestPort < 1 || guestPort > 65_535) return fail(400, "bad_port");

    // Re-arm from the control plane before an open: the api never dials a
    // runner (it may have no route to one), so an unshare would otherwise
    // leave the port armed here until the next refresh. Coalesced per
    // sandbox within ALLOWLIST_FRESH_MS (a page load opens one stream per
    // asset), so the runner's fence lags the api's rows by at most that
    // window. If the control plane is unreachable, the last arm stands (the
    // relay and the supervisor still enforce it).
    const fresh = now() - (armedAt.get(sandboxId) ?? 0) < allowlistFreshMs;
    (fresh ? Promise.resolve() : rearm(sandboxId).catch(() => undefined))
      .then(() => hub.open(sandboxId, guestPort))
      .then((stream) => {
        if (socket.destroyed) {
          stream.destroy();
          return;
        }
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: ${PORT_STREAM_UPGRADE}\r\n\r\n`,
        );
        if (head.length) stream.write(head);
        socket.pipe(stream).pipe(socket);
        stream.on("error", () => socket.destroy());
        socket.on("close", () => stream.destroy());
      })
      .catch((err: unknown) => {
        const code = err instanceof PortOpenError ? err.code : "failed";
        if (!(err instanceof PortOpenError))
          log("warn", "port stream open failed", { error: String(err) });
        fail(statusForCode[code] ?? 502, code);
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      server.on("error", (err) =>
        log("error", "port API server error", { error: String(err) }),
      );
      log("info", "runner port API listening", { port });
      resolve();
    });
  });

  return {
    close: () => new Promise<void>((r) => server.close(() => r())),
    address: () => server.address(),
    /** The sandbox's channel closed: its next supervisor boots unarmed. */
    sandboxGone: (sandboxId: string) => armedAt.delete(sandboxId),
  };
};
