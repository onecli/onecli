import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  supervisorMessageSchema,
  type SupervisorMessage,
  type WorkItem,
} from "@onecli/agent-protocol";
import { log } from "../log";

/**
 * The supervisor's end of the control channel: the sandbox dials THIS server
 * over the container network (§3.3 — the sandbox never talks to the control
 * plane directly, and the runner still holds no ports the outside world can
 * reach).
 *
 * Authentication is a per-spawn bootstrap token (§5.1): minted when the
 * sandbox is created, delivered in its environment, bound to that one
 * sandbox, and consumed on first connect. It never leaves the host network
 * and cannot be replayed — which matters because possession of the channel
 * means being able to report as that sandbox.
 */

export interface SupervisorConnection {
  sandboxId: string;
  send(item: WorkItem): void;
}

export interface RunnerWsServerOptions {
  port: number;
  /** Called for every valid message a supervisor sends. */
  onMessage: (sandboxId: string, message: SupervisorMessage) => void;
  /** Keepalive cadence override — tests only; see PING_INTERVAL_MS. */
  pingIntervalMs?: number;
}

export interface RunnerWsServer {
  /** Mint a single-use token bound to one sandbox. */
  issueToken(sandboxId: string): string;
  /** Drop a pending token (the spawn failed before the sandbox connected). */
  revokeToken(sandboxId: string): void;
  /**
   * Is a sandbox still expected to dial in? True between minting its token
   * and its first connect — which is what tells reconcile the difference
   * between "starting up" and "running but unreachable".
   */
  awaitingConnection(sandboxId: string): boolean;
  connection(sandboxId: string): SupervisorConnection | undefined;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Keepalive cadence for every supervisor channel. The channel is long-lived
 * and mostly SILENT (an idle agent sends nothing for hours), it cannot
 * reconnect (the bootstrap token is single-use), and in the cloud it rides a
 * network load balancer whose TCP idle timeout (~350s) silently discards
 * quiet flows — after which the next write meets a dead connection and the
 * agent is respawned for no reason. A server-side ping well inside that
 * window keeps the flow alive everywhere; peers answer with pong
 * automatically (`ws` clients and native WebSockets both), so the supervisor
 * needs no change. Keepalive only — dead peers still surface through close
 * events and reconcile, so no terminate-on-missed-pong.
 */
const PING_INTERVAL_MS = 60_000;

export const createRunnerWsServer = ({
  port,
  onMessage,
  pingIntervalMs = PING_INTERVAL_MS,
}: RunnerWsServerOptions): RunnerWsServer => {
  /** token → sandboxId, consumed on connect. */
  const pending = new Map<string, string>();
  const connections = new Map<string, WebSocket>();
  let pingTimer: NodeJS.Timeout | undefined;

  const http: Server = createServer((req, res) => {
    // The compose health check — the only plain HTTP this server answers.
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404).end();
  });

  // The peer is a sandbox running untrusted model output, and this process
  // holds the docker socket — so cap what a single frame can cost us. The
  // supervisor protocol carries small JSON.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  http.on("upgrade", (request, socket, head) => {
    // Before anything else: an unhandled 'error' on a raw socket is an
    // uncaught exception, and this daemon is the whole compute plane. A
    // container killed mid-handshake would otherwise take it down.
    socket.on("error", (err) => {
      log("warn", "upgrade socket error", { error: String(err) });
      socket.destroy();
    });

    const url = new URL(request.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token") ?? "";
    const sandboxId = pending.get(token);

    if (!sandboxId) {
      // Hint-free: an unknown or already-used token is simply refused.
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // Single use: possession of the token proves nothing a second time.
    pending.delete(token);

    wss.handleUpgrade(request, socket, head, (ws) => {
      connections.set(sandboxId, ws);
      log("info", "supervisor connected", { sandboxId });

      ws.on("message", (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          log("warn", "dropping non-JSON supervisor message", { sandboxId });
          return;
        }
        const message = supervisorMessageSchema.safeParse(parsed);
        if (!message.success) {
          log("warn", "dropping invalid supervisor message", { sandboxId });
          return;
        }
        // The sandbox id comes from the AUTHENTICATED channel, never from the
        // message body — a supervisor can only ever speak for itself.
        onMessage(sandboxId, message.data);
      });

      ws.on("close", () => {
        if (connections.get(sandboxId) === ws) connections.delete(sandboxId);
        log("info", "supervisor disconnected", { sandboxId });
      });

      ws.on("error", (err) => {
        log("warn", "supervisor socket error", {
          sandboxId,
          error: String(err),
        });
      });
    });
  });

  return {
    issueToken(sandboxId) {
      // One live token per sandbox: re-issuing invalidates the previous one.
      for (const [token, id] of pending) {
        if (id === sandboxId) pending.delete(token);
      }
      const token = randomBytes(32).toString("hex");
      pending.set(token, sandboxId);
      return token;
    },

    awaitingConnection(sandboxId) {
      for (const owner of pending.values()) {
        if (owner === sandboxId) return true;
      }
      return false;
    },

    revokeToken(sandboxId) {
      for (const [token, id] of pending) {
        if (id === sandboxId) pending.delete(token);
      }
    },

    connection(sandboxId) {
      const ws = connections.get(sandboxId);
      if (!ws) return undefined;
      return {
        sandboxId,
        send(item: WorkItem) {
          ws.send(JSON.stringify(item));
        },
      };
    },

    listen() {
      // Started here rather than at construction so tests that never listen
      // hold no timer, and unref'd so it can never keep the process open.
      pingTimer = setInterval(() => {
        for (const [sandboxId, ws] of connections) {
          try {
            ws.ping();
          } catch (error) {
            log("warn", "supervisor ping failed", {
              sandboxId,
              error: String(error),
            });
          }
        }
      }, pingIntervalMs);
      pingTimer.unref?.();
      return new Promise((resolve, reject) => {
        http.once("error", reject);
        http.listen(port, () => {
          http.off("error", reject);
          // Keep a listener after bind: a later server error (accept-time
          // EMFILE under fd pressure) would otherwise be uncaught.
          http.on("error", (err) => {
            log("error", "control channel server error", {
              error: String(err),
            });
          });
          log("info", "runner control channel listening", { port });
          resolve();
        });
      });
    },

    close() {
      if (pingTimer) clearInterval(pingTimer);
      return new Promise((resolve) => {
        for (const ws of connections.values()) ws.close();
        connections.clear();
        pending.clear();
        wss.close(() => http.close(() => resolve()));
      });
    },
  };
};
