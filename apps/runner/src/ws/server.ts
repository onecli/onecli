import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  sequencedFrameSchema,
  supervisorMessageSchema,
  type RunnerChannelClaimRequest,
  type RunnerChannelClaimResponse,
  type SupervisorMessage,
  type WorkItem,
} from "@onecli/agent-protocol";
import { log } from "../log";
import type { SessionKeyring } from "./session";

/**
 * The supervisor's end of the control channel: the sandbox dials THIS server
 * over the container network (§3.3: the sandbox never talks to the control
 * plane directly, and the runner holds no ports the outside world reaches).
 *
 * The runner may run as several copies behind one address, and a supervisor
 * reaches whichever copy the load balancer picks, so the control plane is
 * the source of truth for every channel. A socket is admitted through one of
 * two doors, and either way the copy CLAIMS the channel from the control
 * plane, which records it as the holder (work that needs the socket is then
 * handed to this copy only):
 *
 * - The bootstrap TOKEN (a first connect). Minted per spawn, baked into the
 *   sandbox's environment, and recorded with the control plane by its
 *   SHA-256 only. Claiming it uses it up across every copy, and the answer
 *   names the sandbox and container it was minted for. Possession of the
 *   channel means reporting as that sandbox, so a token never works twice.
 * - The SESSION (a reconnect). An HMAC over the sandbox and its container
 *   under the fleet key (`ws/session.ts`), handed on every connect. Verified
 *   here against the container the control plane records (no shared state
 *   in any process), then claimed. While the control plane is unreachable a
 *   locally valid session is accepted and the claim retried, so a running
 *   sandbox stays connected through an outage.
 *
 * Frames from a session-holding supervisor arrive in a sequenced envelope:
 * each `seq` is applied at most once per copy and acked, so a replay after a
 * gap is exactly-once on one copy and at-least-once across a move.
 */

/** A fresh single-use bootstrap token: 32 random bytes, hex. */
export const mintBootstrapToken = (): string => randomBytes(32).toString("hex");

/** The only form a bootstrap token ever leaves the copy in. */
export const hashBootstrapToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

/**
 * The control plane's side of the channel records, as the server needs it.
 * `claim` resolves `null` when refused and throws when the control plane
 * cannot be asked; `containerOf` is the container the control plane records
 * for a sandbox (throws when it cannot be asked); `release` hands a closed
 * socket's channel back and must never throw (it retries on its own).
 */
export interface ChannelPlane {
  claim(
    claim: RunnerChannelClaimRequest,
  ): Promise<RunnerChannelClaimResponse | null>;
  containerOf(sandboxId: string): Promise<string | undefined>;
  release(connectionId: string): void;
}

export interface SupervisorConnection {
  sandboxId: string;
  send(item: WorkItem): void;
}

export interface RunnerWsServerOptions {
  port: number;
  /** Called for every valid message a supervisor sends. */
  onMessage: (sandboxId: string, message: SupervisorMessage) => void;
  channels: ChannelPlane;
  /** Resumable sessions; absent = bootstrap-only. */
  keyring?: SessionKeyring;
  /** Keepalive cadence override; tests only, see PING_INTERVAL_MS. */
  pingIntervalMs?: number;
  /** First re-claim backoff override; tests only, see RECLAIM_MIN_MS. */
  reclaimMinMs?: number;
}

export interface RunnerWsServer {
  /** Does this server hand out sessions (a keyring is configured)? */
  readonly resumable: boolean;
  /** This copy's live socket for a sandbox, if it holds one. */
  connection(sandboxId: string): SupervisorConnection | undefined;
  /** The container this copy's live socket for a sandbox authenticated as:
   * what process and port frames are stamped with. */
  containerRefOf(sandboxId: string): string | undefined;
  /** Register a callback for a supervisor socket closing (port streams, and
   * the runner's check of the container the socket was for). */
  onDisconnect(
    listener: (sandboxId: string, containerRef: string) => void,
  ): void;
  listen(): Promise<void>;
  /** The port actually bound once listening (resolves a `port: 0` bind). */
  boundPort(): number;
  /**
   * The graceful half of a shutdown: stop admitting (and answer the health
   * check as not ready), then close every socket with 1012 "service
   * restart" so its supervisor reconnects, with its session, to another
   * copy. Resolves once the sockets have closed (bounded).
   */
  drain(): Promise<void>;
  close(): Promise<void>;
  /**
   * Tests only: drop every socket at the TCP level with no close frame and
   * no release, and free the port, the way a killed process does.
   */
  crash(): Promise<void>;
}

/**
 * Keepalive cadence for every supervisor channel. The channel is long-lived
 * and mostly SILENT, and a load balancer in front of the runner may drop a
 * flow that stays quiet past its idle timeout (often a few minutes). A
 * server-side ping well inside that window keeps the flow alive; peers
 * answer with pong automatically. Keepalive only: dead peers surface
 * through close events and reconcile.
 */
const PING_INTERVAL_MS = 60_000;
/** Backoff bounds for re-claiming a socket admitted during an outage. */
const RECLAIM_MIN_MS = 1_000;
const RECLAIM_MAX_MS = 15_000;
/** Longest `drain` waits for its sockets to close. */
const DRAIN_WAIT_MS = 2_000;
/** 1012: the server is restarting; the client should reconnect. */
const CLOSE_RESTART = 1012;
/** 1008: the control plane refused this socket's channel. */
const CLOSE_REFUSED = 1008;

type Refusal = "401 Unauthorized" | "503 Service Unavailable";

interface Admitted {
  sandboxId: string;
  containerRef: string;
  connectionId: string;
  connectedAt: number;
  /** The control plane could not be asked; the claim is still owed. */
  claimOwed: boolean;
}

interface Channel extends Admitted {
  ws: WebSocket;
  /** Settles once this socket's claim is resolved one way or another, so a
   * release is never sent ahead of the claim it undoes. */
  claimed: Promise<void>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

export const createRunnerWsServer = ({
  port,
  onMessage,
  channels,
  keyring,
  pingIntervalMs = PING_INTERVAL_MS,
  reclaimMinMs = RECLAIM_MIN_MS,
}: RunnerWsServerOptions): RunnerWsServer => {
  /** sandboxId → this copy's live socket for it. */
  const live = new Map<string, Channel>();
  /** sandboxId → the container this copy last admitted it as: the first
   * place a session is verified against. */
  const known = new Map<string, string>();
  /**
   * sandboxId → the ack cursor over its supervisor's sequenced frames, for
   * one container (a recreated container starts its numbering again, so a
   * cursor for another container is reset, never carried over).
   */
  const cursors = new Map<string, { containerRef: string; seq: number }>();
  const disconnectListeners: Array<
    (sandboxId: string, containerRef: string) => void
  > = [];
  let pingTimer: NodeJS.Timeout | undefined;
  let draining = false;
  /** Set by `crash`: sockets die with no close frame and nothing released. */
  let crashed = false;

  const cursorFor = (sandboxId: string, containerRef: string) => {
    const cursor = cursors.get(sandboxId);
    if (cursor?.containerRef === containerRef) return cursor;
    const fresh = { containerRef, seq: 0 };
    cursors.set(sandboxId, fresh);
    return fresh;
  };

  /**
   * The container a session credential is valid for, or undefined. This
   * copy's own record first (no round trip for a supervisor reconnecting to
   * the copy it left); then the control plane's, which is how a copy that
   * never saw the sandbox (it reconnected here from another copy) and a
   * recreated container are both answered correctly.
   */
  const sessionContainer = async (
    credential: string,
    sandboxId: string,
  ): Promise<string | undefined> => {
    if (!keyring) return undefined;
    const local = known.get(sandboxId);
    if (local !== undefined && keyring.verify(credential, sandboxId, local)) {
      return local;
    }
    let recorded: string | undefined;
    try {
      recorded = await channels.containerOf(sandboxId);
    } catch (error) {
      log("warn", "could not look up a sandbox's container", {
        sandboxId,
        error: String(error),
      });
      return undefined;
    }
    if (recorded === undefined || recorded === local) return undefined;
    return keyring.verify(credential, sandboxId, recorded)
      ? recorded
      : undefined;
  };

  /** Which channel an upgrade becomes, or why not. Every refusal of a
   * credential is the same hint-free 401. */
  const admit = async (url: URL): Promise<Admitted | Refusal> => {
    if (draining) return "503 Service Unavailable";
    const connectionId = randomUUID();
    const connectedAt = Date.now();

    const token = url.searchParams.get("token");
    if (token) {
      try {
        const answer = await channels.claim({
          door: "token",
          connectionId,
          connectedAt,
          tokenHash: hashBootstrapToken(token),
        });
        if (!answer) return "401 Unauthorized";
        return { ...answer, connectionId, connectedAt, claimOwed: false };
      } catch (error) {
        // A first connect has nothing local to trust: refuse, and the
        // supervisor retries until the control plane answers.
        log("warn", "could not claim a first connect", {
          error: String(error),
        });
        return "503 Service Unavailable";
      }
    }

    const credential = url.searchParams.get("session");
    const sandboxId = url.searchParams.get("sandbox");
    if (!credential || !sandboxId) return "401 Unauthorized";
    const containerRef = await sessionContainer(credential, sandboxId);
    if (containerRef === undefined) return "401 Unauthorized";
    try {
      const answer = await channels.claim({
        door: "session",
        connectionId,
        connectedAt,
        sandboxId,
        containerRef,
      });
      if (!answer) return "401 Unauthorized";
      return { ...answer, connectionId, connectedAt, claimOwed: false };
    } catch (error) {
      log("warn", "control plane unreachable; admitting a valid session", {
        sandboxId,
        error: String(error),
      });
      return {
        sandboxId,
        containerRef,
        connectionId,
        connectedAt,
        claimOwed: true,
      };
    }
  };

  /**
   * The claim a socket admitted during an outage still owes, retried until
   * the control plane answers or the socket closes. A refusal (the
   * container was replaced meanwhile) closes the socket.
   */
  const settleOwedClaim = async (channel: Channel): Promise<void> => {
    for (
      let delay = reclaimMinMs;
      ;
      delay = Math.min(delay * 2, RECLAIM_MAX_MS)
    ) {
      await sleep(delay);
      if (channel.ws.readyState !== channel.ws.OPEN) return;
      try {
        const answer = await channels.claim({
          door: "session",
          connectionId: channel.connectionId,
          connectedAt: channel.connectedAt,
          sandboxId: channel.sandboxId,
          containerRef: channel.containerRef,
        });
        if (!answer) {
          log("warn", "control plane refused a channel admitted offline", {
            sandboxId: channel.sandboxId,
          });
          channel.ws.close(CLOSE_REFUSED, "channel refused");
        }
        return;
      } catch {
        // Still unreachable: keep the socket and try again.
      }
    }
  };

  /** The session hand-off, sent on every connect: the credential the
   * supervisor presents next time, and where its replay starts. */
  const handOffSession = (channel: Channel) => {
    if (!keyring) return;
    channel.ws.send(
      JSON.stringify({
        kind: "session",
        credential: keyring.sign(channel.sandboxId, channel.containerRef),
        ack: cursorFor(channel.sandboxId, channel.containerRef).seq,
      } satisfies WorkItem),
    );
  };

  const onFrame = (channel: Channel, data: WebSocket.RawData) => {
    const { sandboxId } = channel;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      log("warn", "dropping non-JSON supervisor message", { sandboxId });
      return;
    }
    // Two shapes: a sequenced envelope from a session-holding supervisor
    // (applied at most once per seq, acked), or a bare frame from one that
    // predates sessions (passed through as it always was).
    const envelope = sequencedFrameSchema.safeParse(parsed);
    if (envelope.success) {
      if (!keyring) {
        // Only reachable by a forged frame: a supervisor wraps only after
        // it holds a session, and this server hands none out.
        log("warn", "dropping sequenced frame outside a session", {
          sandboxId,
        });
        return;
      }
      const cursor = cursorFor(sandboxId, channel.containerRef);
      const { seq, message } = envelope.data;
      if (seq > cursor.seq) {
        cursor.seq = seq;
        onMessage(sandboxId, message);
      }
      // A replay after a gap is acked again and dropped: the design working.
      channel.ws.send(
        JSON.stringify({ kind: "ack", seq: cursor.seq } satisfies WorkItem),
      );
      return;
    }
    const message = supervisorMessageSchema.safeParse(parsed);
    if (!message.success) {
      log("warn", "dropping invalid supervisor message", { sandboxId });
      return;
    }
    // The sandbox id comes from the AUTHENTICATED channel, never the body: a
    // supervisor can only ever speak for itself.
    onMessage(sandboxId, message.data);
  };

  const attach = (ws: WebSocket, admitted: Admitted) => {
    const channel: Channel = { ...admitted, ws, claimed: Promise.resolve() };
    if (admitted.claimOwed) channel.claimed = settleOwedClaim(channel);
    const { sandboxId } = channel;

    // One live socket per sandbox on this copy: the newest dial-in is the
    // one the supervisor is listening on (an old flow may be half-dead).
    const previous = live.get(sandboxId);
    if (previous) previous.ws.close();
    live.set(sandboxId, channel);
    known.set(sandboxId, channel.containerRef);
    handOffSession(channel);
    log("info", "supervisor connected", {
      sandboxId,
      claimOwed: admitted.claimOwed,
    });
    // Admitted while this copy started draining: it now holds a session,
    // so it can move on to another copy like every other socket here.
    if (draining) ws.close(CLOSE_RESTART, "runner restarting");

    ws.on("message", (data) => onFrame(channel, data));
    ws.on("close", () => {
      if (crashed) return;
      // Fenced by connection on the control plane: a release for a socket
      // that was already replaced (here or on another copy) changes
      // nothing, so every socket releases its own, after its claim.
      void channel.claimed.then(() => channels.release(channel.connectionId));
      if (live.get(sandboxId) !== channel) return;
      live.delete(sandboxId);
      log("info", "supervisor disconnected", { sandboxId });
      // Port streams never survive a socket: the hub tears them down here.
      for (const listener of disconnectListeners) {
        try {
          listener(sandboxId, channel.containerRef);
        } catch (error) {
          log("warn", "disconnect listener failed", { error: String(error) });
        }
      }
    });
    ws.on("error", (err) => {
      log("warn", "supervisor socket error", { sandboxId, error: String(err) });
    });
  };

  const http: Server = createServer((req, res) => {
    // The health check: ready while admitting, not once draining, so the
    // load balancer stops sending new flows to a copy on its way out.
    if (req.url === "/healthz") {
      res.writeHead(draining ? 503 : 200, { "content-type": "text/plain" });
      res.end(draining ? "draining" : "ok");
      return;
    }
    res.writeHead(404).end();
  });

  // The peer is a sandbox running untrusted model output: cap what a single
  // frame can cost. The supervisor protocol carries small JSON.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  const refuse = (
    socket: NodeJS.WritableStream & { destroy(): void },
    status: Refusal,
  ) => {
    socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
    socket.destroy();
  };

  http.on("upgrade", (request: IncomingMessage, socket, head) => {
    // Before anything else: an unhandled 'error' on a raw socket is an
    // uncaught exception, and this daemon is the whole compute plane.
    socket.on("error", (err) => {
      log("warn", "upgrade socket error", { error: String(err) });
      socket.destroy();
    });
    const url = new URL(request.url ?? "/", "http://localhost");
    admit(url).then(
      (admission) => {
        if (socket.destroyed) return;
        if (typeof admission === "string") return refuse(socket, admission);
        // Admitted means claimed: even a copy that started draining since
        // must complete this upgrade (a refused first connect would burn its
        // single-use token). `attach` hands it its session and moves it on.
        wss.handleUpgrade(request, socket, head, (ws) => attach(ws, admission));
      },
      (error: unknown) => {
        log("warn", "upgrade failed", { error: String(error) });
        if (!socket.destroyed) refuse(socket, "503 Service Unavailable");
      },
    );
  });

  const waitClosed = (sockets: WebSocket[]): Promise<void> =>
    Promise.race([
      Promise.all(
        sockets.map(
          (ws) =>
            new Promise<void>((resolve) => {
              if (ws.readyState === ws.CLOSED) return resolve();
              ws.once("close", () => resolve());
            }),
        ),
      ).then(() => undefined),
      sleep(DRAIN_WAIT_MS),
    ]);

  return {
    resumable: keyring !== undefined,

    connection(sandboxId) {
      const channel = live.get(sandboxId);
      if (!channel) return undefined;
      return {
        sandboxId,
        send(item: WorkItem) {
          channel.ws.send(JSON.stringify(item));
        },
      };
    },

    containerRefOf: (sandboxId) => live.get(sandboxId)?.containerRef,

    onDisconnect(listener) {
      disconnectListeners.push(listener);
    },

    listen() {
      pingTimer = setInterval(() => {
        for (const [sandboxId, channel] of live) {
          try {
            channel.ws.ping();
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

    boundPort() {
      const address = http.address();
      return typeof address === "object" && address !== null
        ? address.port
        : port;
    },

    async drain() {
      draining = true;
      const sockets = [...live.values()].map((channel) => channel.ws);
      for (const ws of sockets) ws.close(CLOSE_RESTART, "runner restarting");
      await waitClosed(sockets);
    },

    close() {
      draining = true;
      if (pingTimer) clearInterval(pingTimer);
      return new Promise((resolve) => {
        for (const channel of live.values()) channel.ws.close();
        wss.close(() => http.close(() => resolve()));
      });
    },

    crash() {
      crashed = true;
      if (pingTimer) clearInterval(pingTimer);
      return new Promise((resolve) => {
        for (const channel of live.values()) channel.ws.terminate();
        live.clear();
        http.closeAllConnections();
        wss.close(() => http.close(() => resolve()));
      });
    },
  };
};
