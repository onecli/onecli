import { setTimeout as sleep } from "node:timers/promises";
import {
  ResolverRefusedError,
  ResolverUnreachableError,
  type Resolver,
} from "./backend/types";
import {
  ControlPlaneUnreachableError,
  type ControlPlaneClient,
  type OpenedSession,
} from "./control-plane-client";
import { logger } from "./logger";
import type { TerminatorMetrics } from "./metrics";

const log = logger.child({ component: "ssh-session" });

/**
 * One authenticated SSH connection's control-plane session: open-once,
 * heartbeat loop, local policy enforcement (max duration + idle), wake-wait
 * resolving, and the close-exactly-once contract — every exit path reports
 * the close to the control plane AND closes the resolver's session (both
 * best-effort; a crash-orphaned row is closed by the control-plane sweep).
 */

/** Close reasons this daemon originates (the revocation reason may also come
 * verbatim from the control plane's heartbeat answer). */
export const CLOSE_CLIENT_DISCONNECT = "client_disconnect";
export const CLOSE_REVOKED = "revoked";
export const CLOSE_CONTROL_PLANE_UNREACHABLE = "control_plane_unreachable";
export const CLOSE_MAX_SESSION = "max_session";
export const CLOSE_IDLE_TIMEOUT = "idle_timeout";
export const CLOSE_WAKE_TIMEOUT = "wake_timeout";
export const CLOSE_RELAY_ERROR = "relay_error";
export const CLOSE_BROKER_REFUSED = "broker_refused";
export const CLOSE_SHUTDOWN = "terminator_shutdown";

/** Consecutive heartbeat transport failures tolerated before failing closed
 * (the lease expires server-side anyway — holding on longer is dishonest). */
const HEARTBEAT_STRIKES = 3;

/** Cadence of the local idle/max-duration policy check. */
const POLICY_TICK_MS = 1_000;

/** A cached exec target this close to expiry is re-resolved, not reused. */
const TOKEN_REUSE_MARGIN_MS = 30_000;

const PROGRESS_THROTTLE_MS = 10_000;

/**
 * How long a closing session waits for its banner to reach the socket before
 * severing the transport anyway.
 *
 * Same ordering rule as the terminator server's refusal path: writing the
 * banner and calling `endConnection()` in the SAME tick loses it — OpenSSH
 * takes the DISCONNECT out of the same read batch and exits without flushing.
 * Measured on the dev live gate: deleting the terminator pod dropped a live
 * PTY session in 0.8s but printed a bare "Received disconnect … :11:" instead
 * of "the server is shutting down, reconnect shortly". Revocation, max
 * duration and idle timeout all ride the same path, so all four reasons were
 * invisible.
 */
const BANNER_DRAIN_TIMEOUT_MS = 2_000;

/** Resolves when `settle` reports done, or when the drain bound elapses —
 * never rejects, so a wedged peer cannot pin a closing session's socket. */
const drainBounded = (settle: (done: () => void) => void): Promise<void> =>
  new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, BANNER_DRAIN_TIMEOUT_MS);
    timer.unref();
    try {
      settle(finish);
    } catch {
      finish();
    }
  });

/**
 * Resolves when the channel reports closed, or when the bound elapses.
 *
 * The write-flush callback is a necessary but WEAK barrier: it proves the
 * banner bytes reached our socket, not that the client processed them. On a
 * loaded host the DISCONNECT that `endConnection()` sends lands in the same
 * client read batch as the banner, and OpenSSH exits on the disconnect
 * without flushing what it buffered — the exact refusal-path failure
 * documented at REFUSAL_DRAIN_TIMEOUT_MS (server.ts). The channel's 'close'
 * event is the strong barrier the refusal path already uses: it fires on the
 * client's CHANNEL_CLOSE ack, which the client only sends after it has read
 * the banner data ahead of it. Registered BEFORE `channel.end()` so the ack
 * cannot be missed; channels that cannot report closure resolve immediately.
 */
const closeAcked = (channel: NotifiableChannel): Promise<void> => {
  const once = channel.once?.bind(channel);
  if (!once) return Promise.resolve();
  return drainBounded((done) => once("close", done));
};

export class WakeTimeoutError extends Error {
  constructor() {
    super("sandbox did not wake in time");
    this.name = "WakeTimeoutError";
  }
}

export class SessionClosedError extends Error {
  constructor() {
    super("session already closed");
    this.name = "SessionClosedError";
  }
}

export interface ConnectionSessionDeps<T> {
  controlPlane: ControlPlaneClient;
  resolver: Resolver<T>;
  metrics: TerminatorMetrics;
  wakeWaitSeconds: number;
  /** Resolver poll cadence; test knob (production default 2s). */
  wakePollMs?: number;
  now?: () => number;
}

export interface ConnectionSessionInput {
  /** The certificate line, reconstructed from the verified auth blob. */
  certificate: string;
  sourceIp: string;
  agentId: string;
  /** Severs the underlying ssh2 connection (client.end()). */
  endConnection(): void;
}

/** What the session needs from a registered channel (structurally satisfied
 * by ssh2's ServerChannel; minimal so tests can hand in plain fakes).
 * The write callback is load-bearing, not decoration — see
 * BANNER_DRAIN_TIMEOUT_MS. */
export interface NotifiableChannel {
  write(data: string, flushed?: () => void): boolean;
  end(): void;
  /** Close-ack barrier for bannered closes (see closeAcked). Optional so
   * plain test fakes stay valid; ssh2's ServerChannel satisfies it. */
  once?(event: "close", listener: () => void): unknown;
}

export interface ConnectionSession<T> {
  /** Open the control-plane session (memoized — one per connection). */
  open(): Promise<OpenedSession>;
  /**
   * Resolve the exec target, waking the sandbox if needed. `onWaking`
   * receives throttled human-readable progress lines.
   */
  ensureTarget(onWaking: (line: string) => void): Promise<T>;
  /**
   * Drop the cached exec target so the next ensureTarget re-resolves. The
   * cache holds a target for up to ~570s with no failure-driven refresh —
   * a reaped session trio or a re-pinned pod makes it stale mid-session,
   * and the dial-retry path (server.ts) is what heals that (step 6).
   */
  invalidateTarget(): void;
  registerChannel(channel: NotifiableChannel, hasPty: boolean): () => void;
  /** Idle-timeout feed. */
  touch(): void;
  /** First relay established — heartbeats now report attached. */
  markAttached(): void;
  /** Idempotent; the first reason wins. Resolves once reports finished. */
  close(reason: string, banner?: string): Promise<void>;
  readonly isClosed: boolean;
  /** The certified principal — for logging a refusal, which has no session id. */
  readonly agentId: string;
}

export const createConnectionSession = <T>(
  deps: ConnectionSessionDeps<T>,
  input: ConnectionSessionInput,
): ConnectionSession<T> => {
  const now = deps.now ?? Date.now;
  const wakePollMs = deps.wakePollMs ?? 2_000;

  let openPromise: Promise<OpenedSession> | null = null;
  let closed = false;
  let closeReported: Promise<void> = Promise.resolve();
  let attached = false;
  let lastActivityAt = now();
  let openedAt = 0;
  let policyTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let heartbeatInFlight = false;
  let heartbeatStrikes = 0;
  const channels = new Set<{ channel: NotifiableChannel; hasPty: boolean }>();

  let cachedTarget: { target: T; expiresAt: Date } | null = null;
  let wakeInFlight: Promise<T> | null = null;
  let wakeCompleted = false;

  const session: ConnectionSession<T> = {
    get isClosed() {
      return closed;
    },

    agentId: input.agentId,

    open() {
      if (closed) return Promise.reject(new SessionClosedError());
      if (openPromise) return openPromise;
      openPromise = (async () => {
        const opened = await deps.controlPlane.openSession({
          certificate: input.certificate,
          sourceIp: input.sourceIp,
        });
        deps.metrics.sessionOpened();
        log.info(
          { sessionId: opened.sessionId, agentId: input.agentId },
          "ssh session opened",
        );
        openedAt = now();
        lastActivityAt = openedAt;
        // A close that raced this open already captured the promise and will
        // report once it resolves — just never start loops on a closed
        // session.
        if (!closed) {
          startPolicyLoop(opened);
          startHeartbeatLoop(opened);
        }
        return opened;
      })();
      openPromise.catch(() => {
        // A refused open leaves no session to close later; clear so a
        // subsequent channel on the same connection may retry.
        openPromise = null;
      });
      return openPromise;
    },

    async ensureTarget(onWaking) {
      const opened = await session.open();
      if (
        cachedTarget &&
        cachedTarget.expiresAt.getTime() - now() > TOKEN_REUSE_MARGIN_MS
      ) {
        return cachedTarget.target;
      }
      if (!wakeInFlight) {
        wakeInFlight = pollResolver(opened, onWaking).finally(() => {
          wakeInFlight = null;
        });
      }
      return wakeInFlight;
    },

    invalidateTarget() {
      cachedTarget = null;
    },

    registerChannel(channel, hasPty) {
      const entry = { channel, hasPty };
      channels.add(entry);
      return () => channels.delete(entry);
    },

    touch() {
      lastActivityAt = now();
    },

    markAttached() {
      if (attached) return;
      attached = true;
      // Immediate heartbeat so attachedAt is stamped promptly (and short
      // sessions still record their attach).
      void runHeartbeat();
    },

    close(reason, banner) {
      if (closed) return closeReported;
      closed = true;
      if (policyTimer) clearInterval(policyTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      const flushes: Array<Promise<void>> = [];
      for (const { channel, hasPty } of channels) {
        try {
          if (banner && hasPty) {
            // Two barriers, both bounded: the local write flush AND the
            // client's CHANNEL_CLOSE ack (closeAcked — subscribed before
            // end() so it cannot be missed). The flush alone proved too
            // weak: it races the DISCONNECT into the client's same read
            // batch on a loaded host, and OpenSSH exits without printing
            // the banner.
            const acked = closeAcked(channel);
            flushes.push(
              // The write flush: the banner bytes reached our socket.
              drainBounded((done) => channel.write(`\r\n${banner}\r\n`, done)),
              acked,
            );
          }
          channel.end();
        } catch {
          // A torn channel changes nothing about the close contract.
        }
      }
      channels.clear();
      // Report immediately (the control plane should learn now), but sever the
      // transport only once the banner has left, so the client renders the
      // reason instead of a bare disconnect. Bounded, so a stalled peer cannot
      // keep a closed session's socket alive. The returned promise covers BOTH
      // so callers that sever afterwards — drain() — cannot outrun the flush.
      const reporting = reportClose(reason);
      const severing =
        flushes.length === 0
          ? Promise.resolve()
          : Promise.all(flushes).then(() => undefined);
      closeReported = Promise.all([
        reporting,
        severing.then(() => input.endConnection()),
      ]).then(() => undefined);
      return closeReported;
    },
  };

  const reportClose = (reason: string): Promise<void> => {
    const pending = openPromise;
    return (async () => {
      let opened: OpenedSession | null = null;
      try {
        opened = pending ? await pending : null;
      } catch {
        opened = null;
      }
      if (!opened) return;
      log.info(
        { sessionId: opened.sessionId, agentId: input.agentId, reason },
        "ssh session closed",
      );
      deps.metrics.sessionClosed();
      await Promise.allSettled([
        deps.controlPlane.close(opened.sessionId, reason).catch((error) => {
          log.warn(
            { sessionId: opened.sessionId, err: error },
            "close report failed",
          );
        }),
        deps.resolver.close(opened.sessionId).catch((error) => {
          log.warn(
            { sessionId: opened.sessionId, err: error },
            "resolver session delete failed",
          );
        }),
      ]);
    })();
  };

  const startPolicyLoop = (opened: OpenedSession): void => {
    policyTimer = setInterval(() => {
      const at = now();
      if (at - openedAt >= opened.policy.maxSessionSeconds * 1000) {
        void session.close(
          CLOSE_MAX_SESSION,
          "session closed: maximum duration reached",
        );
        return;
      }
      if (at - lastActivityAt >= opened.policy.idleTimeoutSeconds * 1000) {
        void session.close(CLOSE_IDLE_TIMEOUT, "session closed: idle timeout");
      }
    }, POLICY_TICK_MS);
    policyTimer.unref();
  };

  const runHeartbeat = async (): Promise<void> => {
    if (closed || heartbeatInFlight || !openPromise) return;
    heartbeatInFlight = true;
    try {
      const opened = await openPromise;
      const answer = await deps.controlPlane.heartbeat(
        opened.sessionId,
        attached,
      );
      heartbeatStrikes = 0;
      if (answer.revoked) {
        void session.close(
          answer.reason ?? CLOSE_REVOKED,
          "your access was revoked",
        );
      }
    } catch (error) {
      if (error instanceof ControlPlaneUnreachableError) {
        heartbeatStrikes += 1;
        if (heartbeatStrikes >= HEARTBEAT_STRIKES) {
          // Fail closed: the lease is expiring server-side anyway, and a
          // relay that cannot re-check access must not keep relaying.
          void session.close(
            CLOSE_CONTROL_PLANE_UNREACHABLE,
            "session closed: control plane unreachable",
          );
        }
      } else {
        log.warn({ err: error }, "heartbeat failed");
      }
    } finally {
      heartbeatInFlight = false;
    }
  };

  const startHeartbeatLoop = (opened: OpenedSession): void => {
    heartbeatTimer = setInterval(() => {
      void runHeartbeat();
    }, opened.policy.heartbeatSeconds * 1000);
    heartbeatTimer.unref();
  };

  const pollResolver = async (
    opened: OpenedSession,
    onWaking: (line: string) => void,
  ): Promise<T> => {
    const startedAt = now();
    const deadline = startedAt + deps.wakeWaitSeconds * 1000;
    let lastProgressAt = 0;
    for (;;) {
      if (closed) throw new SessionClosedError();
      let waking = false;
      try {
        const answer = await deps.resolver.open({
          certificate: input.certificate,
          grant: opened.grant,
        });
        if (answer.status === "ready") {
          if (!wakeCompleted) {
            wakeCompleted = true;
            deps.metrics.wakeWaitSeconds((now() - startedAt) / 1000);
          }
          cachedTarget = { target: answer.target, expiresAt: answer.expiresAt };
          return answer.target;
        }
        waking = true;
      } catch (error) {
        if (error instanceof ResolverRefusedError) throw error;
        if (!(error instanceof ResolverUnreachableError)) throw error;
        // Transient: ride it out inside the wake window, like a wake poll.
      }
      if (waking && now() - lastProgressAt >= PROGRESS_THROTTLE_MS) {
        lastProgressAt = now();
        onWaking("⏳ waking your agent…");
      }
      if (now() + wakePollMs > deadline) throw new WakeTimeoutError();
      await sleep(wakePollMs);
    }
  };

  return session;
};
