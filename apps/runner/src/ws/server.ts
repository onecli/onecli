import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  sequencedFrameSchema,
  supervisorMessageSchema,
  type SupervisorMessage,
  type WorkItem,
} from "@onecli/agent-protocol";
import { log } from "../log";
import type { SessionKeyring } from "./session";

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
 *
 * The RESUMABLE channel (`sessions`): on every successful connect the server
 * hands the supervisor a session credential (`ws/session.ts`: an HMAC over
 * the sandbox and its container under the fleet key) that it presents on its
 * next connect. Unlike the token, the credential lives in no process memory,
 * so the runner process that replaces this one after a deploy or a crash
 * verifies it the same way. Frames from a session-holding supervisor arrive
 * in a sequenced envelope; the server applies each `seq` at most once and
 * acks its cursor, so a replay after a gap is exactly-once. Without a
 * keyring none of this exists and the channel behaves as it always did.
 */

export interface SupervisorConnection {
  sandboxId: string;
  send(item: WorkItem): void;
}

export interface RunnerWsSessionOptions {
  keyring: SessionKeyring;
  /**
   * The container this runner knows for a sandbox (the same map the message
   * handler stamps `process.state` from). A session is verified against it,
   * so an unknown or recreated container refuses the credential.
   */
  containerRefOf: (sandboxId: string) => string | undefined;
}

export interface RunnerWsServerOptions {
  port: number;
  /** Called for every valid message a supervisor sends. */
  onMessage: (sandboxId: string, message: SupervisorMessage) => void;
  /** Keepalive cadence override — tests only; see PING_INTERVAL_MS. */
  pingIntervalMs?: number;
  /** Resumable sessions; absent = bootstrap-only (today's behaviour). */
  sessions?: RunnerWsSessionOptions;
}

export interface RunnerWsServer {
  /** Does this server hand out sessions (a keyring is configured)? */
  readonly resumable: boolean;
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
  /**
   * When a session-holding sandbox's channel dropped (ms since epoch), until
   * it reconnects. Undefined while connected, and for sandboxes that never
   * held a session (an old supervisor), whose drop is a death as before.
   * Reconcile reads this to keep a reconnecting sandbox out of the
   * "channelless" classification for the resume grace.
   */
  disconnectedAt(sandboxId: string): number | undefined;
  /**
   * Forget a sandbox's resume state: its container is gone, so no
   * supervisor can be reconnecting and the grace must not hold. A later
   * reconnect with its credential is refused anyway (the container ref no
   * longer resolves); this just stops the runner waiting for one.
   */
  forgetSession(sandboxId: string): void;
  /**
   * The runner has just recorded this sandbox's container ref. If its
   * supervisor is already connected without a session (it dialled in before
   * the ref existed: the cloud backend's order), hand it one now. A no-op
   * otherwise, and without a keyring.
   */
  containerKnown(sandboxId: string): void;
  listen(): Promise<void>;
  close(): Promise<void>;
  /**
   * Tests only: drop every socket at the TCP level with no close frame and
   * release the port, the way a killed process does. The supervisor must
   * notice through `error`/half-open detection rather than a clean `close`.
   */
  crash(): Promise<void>;
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
  sessions,
}: RunnerWsServerOptions): RunnerWsServer => {
  /** token → sandboxId, consumed on connect. */
  const pending = new Map<string, string>();
  const connections = new Map<string, WebSocket>();
  /**
   * Per-sandbox resume state. Exists only for sandboxes that were handed a
   * session (so only when `sessions` is configured): the ack cursor over
   * the supervisor's sequenced frames, and the moment its channel dropped.
   * Cleared when the sandbox's token is re-issued (a recreate) or revoked.
   */
  const resumable = new Map<
    string,
    { appliedSeq: number; disconnectedAt: number | undefined }
  >();
  let pingTimer: NodeJS.Timeout | undefined;

  /**
   * Which sandbox an upgrade authenticates as, or nothing. Two doors:
   * the single-use bootstrap token (every supervisor's first connect), and
   * the session credential (a reconnect, possibly to a process that never
   * saw the token). Both hint-free on refusal.
   */
  /** Sockets that have been handed a session (the hand-off is once each). */
  const sessionHolders = new WeakSet<WebSocket>();

  /**
   * The session hand-off: the credential this supervisor presents next time,
   * and the cursor it should replay from. Sent once per socket, on EVERY
   * connect (a resumed one too: same facts, same key, same credential), so a
   * supervisor needs no state beyond "the last session item I got".
   *
   * Signed over the container ref, so it needs one. On a substrate whose
   * create returns only once the container runs (the cloud backend's image
   * watch), the supervisor dials in BEFORE the runner has recorded the ref;
   * the hand-off then waits for `containerKnown` and goes out on the live
   * socket. Returns whether a session was handed.
   */
  const handOffSession = (sandboxId: string, ws: WebSocket): boolean => {
    if (!sessions || sessionHolders.has(ws)) return false;
    const containerRef = sessions.containerRefOf(sandboxId);
    if (!containerRef) return false;
    const state = resumable.get(sandboxId) ?? {
      appliedSeq: 0,
      disconnectedAt: undefined,
    };
    state.disconnectedAt = undefined;
    resumable.set(sandboxId, state);
    ws.send(
      JSON.stringify({
        kind: "session",
        credential: sessions.keyring.sign(sandboxId, containerRef),
        ack: state.appliedSeq,
      } satisfies WorkItem),
    );
    sessionHolders.add(ws);
    return true;
  };

  const authenticate = (url: URL): string | undefined => {
    const token = url.searchParams.get("token");
    if (token) {
      const sandboxId = pending.get(token);
      if (!sandboxId) return undefined;
      // Single use: possession of the token proves nothing a second time.
      pending.delete(token);
      return sandboxId;
    }
    if (!sessions) return undefined;
    const credential = url.searchParams.get("session");
    const sandboxId = url.searchParams.get("sandbox");
    if (!credential || !sandboxId) return undefined;
    // The container is the runner's OWN fact (the map reconcile re-learns
    // at boot), never the supervisor's claim: a recreated container, or one
    // this process has not listed yet, refuses the credential.
    const containerRef = sessions.containerRefOf(sandboxId);
    if (!containerRef) return undefined;
    return sessions.keyring.verify(credential, sandboxId, containerRef)
      ? sandboxId
      : undefined;
  };

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
    const sandboxId = authenticate(url);

    if (!sandboxId) {
      // Hint-free: an unknown or already-used token, or a credential that
      // does not verify, is simply refused.
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      // One live channel per sandbox. A resumed connect while the previous
      // socket is still open (a half-dead load-balancer flow, a supervisor
      // that reconnected before its old socket noticed) replaces it: the
      // newest dial-in is the one the supervisor is actually listening on.
      const previous = connections.get(sandboxId);
      if (previous && previous !== ws) previous.close();
      connections.set(sandboxId, ws);

      // `sessionAtConnect: false` on a keyed runner is normal on cloud: the
      // session follows via `containerKnown` once the ref is recorded.
      const sessionAtConnect = handOffSession(sandboxId, ws);
      log("info", "supervisor connected", { sandboxId, sessionAtConnect });

      ws.on("message", (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          log("warn", "dropping non-JSON supervisor message", { sandboxId });
          return;
        }
        // Two shapes on the wire: a sequenced envelope from a session-holding
        // supervisor, or a bare frame from one that predates sessions. The
        // envelope is applied at most once per seq and acked; the bare frame
        // passes through exactly as it always has.
        const envelope = sequencedFrameSchema.safeParse(parsed);
        if (envelope.success) {
          const state = resumable.get(sandboxId);
          if (!state) {
            // An envelope from a sandbox this server never handed a session:
            // only reachable by a forged frame, since the supervisor wraps
            // only after it holds one.
            log("warn", "dropping sequenced frame outside a session", {
              sandboxId,
            });
            return;
          }
          const { seq, message } = envelope.data;
          if (seq <= state.appliedSeq) {
            // A replay after a gap: already applied, so acked again and
            // dropped. Not a warning: this is the design working.
            ws.send(
              JSON.stringify({
                kind: "ack",
                seq: state.appliedSeq,
              } satisfies WorkItem),
            );
            return;
          }
          state.appliedSeq = seq;
          onMessage(sandboxId, message);
          ws.send(JSON.stringify({ kind: "ack", seq } satisfies WorkItem));
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
        // A superseded socket's close must not disturb the live one.
        if (connections.get(sandboxId) !== ws) return;
        connections.delete(sandboxId);
        const state = resumable.get(sandboxId);
        if (state) state.disconnectedAt = Date.now();
        log("info", "supervisor disconnected", {
          sandboxId,
          resumable: state !== undefined,
        });
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
    resumable: sessions !== undefined,

    issueToken(sandboxId) {
      // One live token per sandbox: re-issuing invalidates the previous one,
      // and a re-issue means a recreate: the old session's cursor and drop
      // time belong to a container that no longer exists, and so does its
      // channel. Close it, so nothing for the NEW container (a late session
      // hand-off above all, signed over the new ref) can land on the old
      // container's socket if that socket never noticed its container die.
      for (const [token, id] of pending) {
        if (id === sandboxId) pending.delete(token);
      }
      resumable.delete(sandboxId);
      const previous = connections.get(sandboxId);
      if (previous) {
        connections.delete(sandboxId);
        previous.close();
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
      resumable.delete(sandboxId);
    },

    disconnectedAt(sandboxId) {
      return resumable.get(sandboxId)?.disconnectedAt;
    },

    forgetSession(sandboxId) {
      resumable.delete(sandboxId);
    },

    containerKnown(sandboxId) {
      const ws = connections.get(sandboxId);
      if (!ws || ws.readyState !== ws.OPEN) return;
      if (handOffSession(sandboxId, ws)) {
        log("info", "supervisor session handed after connect", { sandboxId });
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
        resumable.clear();
        wss.close(() => http.close(() => resolve()));
      });
    },

    crash() {
      if (pingTimer) clearInterval(pingTimer);
      return new Promise((resolve) => {
        for (const ws of connections.values()) ws.terminate();
        connections.clear();
        pending.clear();
        resumable.clear();
        http.closeAllConnections();
        wss.close(() => http.close(() => resolve()));
      });
    },
  };
};
