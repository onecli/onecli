import type { AddressInfo } from "node:net";
// ssh2 is CommonJS with its exports attached at runtime, so Node's
// CJS-interop lexer cannot see them statically: a NAMED value import
// (`import { Server } from "ssh2"`) type-checks and bundles fine, then dies
// at process start with "does not provide an export named 'Server'" — a
// failure only the built bundle on real Node reproduces (vitest resolves the
// interop transparently). Take the default export and destructure at runtime;
// the type-only imports below are erased at build and stay named.
import ssh2, {
  type ClientInfo,
  type Connection,
  type PseudoTtyInfo,
  type ServerChannel,
  type Session,
  type WindowChangeInfo,
} from "ssh2";

const { Server } = ssh2;
import { authenticate, certificateLineOf } from "./auth";
import { ResolverRefusedError, type TerminatorBackend } from "./backend/types";
import {
  SessionOpenRefusedError,
  type ControlPlaneClient,
} from "./control-plane-client";
import type { ConnectionLimits } from "./limits";
import { logger } from "./logger";
import type { TerminatorMetrics } from "./metrics";
import { runRelay, type RelayRequest, type TerminalSizeSource } from "./relay";
import {
  CLOSE_BROKER_REFUSED,
  CLOSE_CLIENT_DISCONNECT,
  CLOSE_RELAY_ERROR,
  CLOSE_SHUTDOWN,
  CLOSE_WAKE_TIMEOUT,
  SessionClosedError,
  WakeTimeoutError,
  createConnectionSession,
  type ConnectionSession,
} from "./session";

const log = logger.child({ component: "terminator-server" });

/**
 * The ssh2 server: pre-auth limits, certificate auth, then per-connection
 * session lifecycle and channel relays. Everything stateful is injected —
 * the e2e suite runs this exact server against fake planes and a local exec
 * backend with the real OpenSSH client dialing in.
 */

/** ssh2 transport keepalives — the NLB idles flows out around 350s, and the
 * exec side is separately pinged by the backend. */
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_COUNT_MAX = 6;

/**
 * Auth attempts one TCP connection may make before it is dropped. ssh2 fires
 * the auth handler per PROTOCOL event, not per key: a normal OpenSSH client
 * with a loaded agent burns one `none` probe plus TWO events per candidate
 * key (publickey query, then the signed attempt), so a ~10-key agent is
 * ~21 events of legitimate traffic. 24 clears that with headroom; anything
 * past it is a probe, and ssh2 itself enforces no cap (step 6 — the
 * auth-failure amplification path).
 */
const MAX_AUTH_ATTEMPTS_PER_CONNECTION = 24;

/**
 * How long a refused channel gets to put its reason on the wire before the
 * transport is severed anyway.
 *
 * Load-bearing: writing the reason and calling `connection.end()` in the SAME
 * tick loses it. OpenSSH then receives the extended data, the channel close
 * and the DISCONNECT in one read batch and exits on the disconnect without
 * flushing what it buffered — so `ssh <agent> <cmd>`, `scp`, `sftp` and VS
 * Code Remote all reported a bare "Received disconnect … :11:" with an empty
 * description while an interactive shell (which drains differently) showed the
 * reason fine. Measured on the dev live gate, packet-traced with `ssh -vvv`
 * ("rcvd ext data 59" arriving, never printed). Draining the channel first
 * puts the DISCONNECT in a later batch, so the reason survives.
 */
const REFUSAL_DRAIN_TIMEOUT_MS = 2_000;

export interface TerminatorServerDeps<T> {
  /** Host private key (OpenSSH/PEM format string). */
  hostKey: string;
  /** Raw 32-byte CA public key. */
  caPublicKey: Buffer;
  controlPlane: ControlPlaneClient;
  /** The substrate: resolver + exec backend, one target vocabulary. */
  backend: TerminatorBackend<T>;
  metrics: TerminatorMetrics;
  limits: ConnectionLimits;
  wakeWaitSeconds: number;
  preauthTimeoutSeconds: number;
  /** Test knobs. */
  wakePollMs?: number;
  now?: () => Date;
}

export interface TerminatorServer {
  /** Resolves with the bound port (pass 0 for an ephemeral one). */
  listen(port: number, host?: string): Promise<number>;
  liveSessions(): number;
  /**
   * Stop accepting, banner + close every live session (reported as
   * `terminator_shutdown`), sever all connections.
   */
  drain(banner: string): Promise<void>;
  close(): Promise<void>;
}

interface SizeTracker {
  setPty(info: PseudoTtyInfo): void;
  change(info: WindowChangeInfo): void;
  source: TerminalSizeSource;
}

const createSizeTracker = (): SizeTracker => {
  let current: { cols: number; rows: number } | null = null;
  const listeners = new Set<(size: { cols: number; rows: number }) => void>();
  return {
    setPty(info) {
      current = { cols: info.cols, rows: info.rows };
    },
    change(info) {
      current = { cols: info.cols, rows: info.rows };
      for (const listener of listeners) listener(current);
    },
    source: {
      current: () => current,
      onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
};

export const createTerminatorServer = <T>(
  deps: TerminatorServerDeps<T>,
): TerminatorServer => {
  const preauthTimeoutMs = deps.preauthTimeoutSeconds * 1000;
  const connections = new Set<Connection>();
  const sessions = new Set<ConnectionSession<T>>();

  /** Resolves when `settle` fires or the bound elapses — never rejects, so a
   * stalled peer cannot pin a refused connection open. */
  const within = (
    settle: (done: () => void) => void,
    timeoutMs: number,
  ): Promise<void> =>
    new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref();
      settle(finish);
    });

  /** A short human line; PTY channels get it inline, exec/sftp on stderr.
   * Resolves once the bytes have reached the socket (or the write threw). */
  const writeNotice = (
    channel: ServerChannel,
    hasPty: boolean,
    message: string,
  ): Promise<void> =>
    within((done) => {
      try {
        if (hasPty) channel.write(`\r\n${message}\r\n`, () => done());
        else channel.stderr.write(`${message}\n`, () => done());
      } catch {
        // A dead channel gets no notice; the close path is unaffected.
        done();
      }
    }, REFUSAL_DRAIN_TIMEOUT_MS);

  /**
   * Refuse this channel with a reason the client actually SEES: flush the
   * notice, report a non-zero exit so scripted callers get a status, close
   * the channel, and only then sever the transport (see
   * REFUSAL_DRAIN_TIMEOUT_MS for why the ordering is the whole point).
   */
  const refuseChannel = async (
    connection: Connection,
    channel: ServerChannel,
    hasPty: boolean,
    message: string,
  ): Promise<void> => {
    await writeNotice(channel, hasPty, message);
    const drained = within(
      (done) => channel.once("close", done),
      REFUSAL_DRAIN_TIMEOUT_MS,
    );
    try {
      channel.exit(1);
      channel.end();
    } catch {
      // Already gone — fall through to ending the connection.
    }
    await drained;
    connection.end();
  };

  const runChannel = async (
    connection: Connection,
    session: ConnectionSession<T>,
    channel: ServerChannel,
    request: RelayRequest,
    size: SizeTracker,
  ): Promise<void> => {
    const hasPty = size.source.current() !== null;
    const unregister = session.registerChannel(channel, hasPty);
    try {
      try {
        await session.open();
      } catch (error) {
        // No control-plane session exists — nothing to report, fail closed.
        // Logged: a refused open is the single most likely thing a customer
        // asks about ("it just disconnects"), and without this line there is
        // no server-side trace of it at all.
        if (error instanceof SessionOpenRefusedError) {
          log.info(
            { status: error.status, agentId: session.agentId },
            "session-open refused by the control plane",
          );
        } else {
          log.warn({ err: error }, "session-open failed");
        }
        const message =
          error instanceof SessionOpenRefusedError
            ? `access denied: ${error.message}`
            : "onecli: could not establish a session, try again shortly";
        await refuseChannel(connection, channel, hasPty, message);
        return;
      }
      let attached = false;
      const dial = async (): Promise<void> => {
        const target = await session.ensureTarget((line) => {
          if (hasPty) channel.write(`${line}\r\n`);
        });
        await runRelay({
          backend: deps.backend.exec,
          target,
          request,
          channel,
          size: size.source,
          onActivity: () => session.touch(),
          onAttached: () => {
            attached = true;
            session.markAttached();
          },
        });
      };
      try {
        await dial();
      } catch (error) {
        // A PRE-attach dial failure means the cached exec credential is
        // stale — the GC reaped this session's trio (its 2h age cap, or the
        // pinned pod churned) and the API server refused the upgrade.
        // Invalidate and re-resolve exactly once: resolveSession recreates a
        // missing trio, so the honest fix is a fresh dial, not an error.
        // Post-attach failures and the classified errors keep their arms.
        if (
          attached ||
          session.isClosed ||
          error instanceof SessionClosedError ||
          error instanceof WakeTimeoutError ||
          error instanceof ResolverRefusedError
        ) {
          throw error;
        }
        log.warn(
          { err: error },
          "exec dial failed before attach; re-resolving the target once",
        );
        session.invalidateTarget();
        await dial();
      }
    } catch (error) {
      if (session.isClosed || error instanceof SessionClosedError) return;
      // Every notice below is AWAITED before the session close severs the
      // connection — same ordering rule as refuseChannel.
      if (error instanceof WakeTimeoutError) {
        await writeNotice(channel, hasPty, "your agent did not wake in time");
        await session.close(CLOSE_WAKE_TIMEOUT);
        return;
      }
      if (error instanceof ResolverRefusedError) {
        log.warn({ code: error.code }, "resolver refused the session");
        await writeNotice(channel, hasPty, "onecli: session refused");
        await session.close(CLOSE_BROKER_REFUSED);
        return;
      }
      log.warn({ err: error }, "relay failed");
      await writeNotice(
        channel,
        hasPty,
        "onecli: connection to your agent lost",
      );
      await session.close(CLOSE_RELAY_ERROR);
    } finally {
      unregister();
    }
  };

  const handleSshSession = (
    connection: Connection,
    session: ConnectionSession<T>,
    sshSession: Session,
  ): void => {
    const size = createSizeTracker();
    // ssh2 hands accept as undefined when the client wants no reply — the
    // types miss that, hence the typeof guards.
    sshSession.on("pty", (accept, _reject, info) => {
      size.setPty(info);
      if (typeof accept === "function") accept();
    });
    sshSession.on("window-change", (accept, _reject, info) => {
      size.change(info);
      if (typeof accept === "function") accept();
    });
    sshSession.on("shell", (accept) => {
      void runChannel(connection, session, accept(), { kind: "shell" }, size);
    });
    sshSession.on("exec", (accept, _reject, info) => {
      void runChannel(
        connection,
        session,
        accept(),
        { kind: "exec", command: info.command },
        size,
      );
    });
    // Deliberately NO 'sftp' listener: without one ssh2 routes the sftp
    // subsystem here and accept() yields a RAW channel (its SFTP class never
    // engages), which is exactly what the byte-pipe relay needs.
    sshSession.on("subsystem", (accept, reject, info) => {
      if (info.name === "sftp") {
        void runChannel(connection, session, accept(), { kind: "sftp" }, size);
        return;
      }
      reject();
    });
  };

  const handleConnection = (client: Connection, info: ClientInfo): void => {
    const release = deps.limits.admit(info.ip);
    if (!release) {
      // Hint-free by design: capped or rate-limited callers learn nothing.
      // Counted (drained, step 6): a DoS and a capped developer are
      // otherwise identical to nothing happening.
      deps.metrics.preauthRefusal();
      client.end();
      return;
    }
    connections.add(client);
    let session: ConnectionSession<T> | null = null;
    let authed = false;
    let authAttempts = 0;

    const preauthTimer = setTimeout(() => {
      if (!authed) client.end();
    }, preauthTimeoutMs);
    preauthTimer.unref();

    client.on("error", (error: Error) => {
      log.debug({ err: error, ip: info.ip }, "connection error");
    });

    client.on("authentication", (ctx) => {
      // ssh2 enforces no attempt cap of its own: one admitted connection
      // could otherwise spam auth attempts for the whole pre-auth window,
      // each one a counted failure (step-6 review — the amplification path).
      authAttempts += 1;
      if (authAttempts > MAX_AUTH_ATTEMPTS_PER_CONNECTION) {
        client.end();
        return;
      }
      const clock = deps.now;
      const outcome = authenticate(ctx, {
        caPublicKey: deps.caPublicKey,
        now: clock?.(),
      });
      if (outcome.state === "rejected" && outcome.counted) {
        deps.metrics.authFailure();
      }
      if (outcome.state === "authenticated") {
        authed = true;
        session = createConnectionSession(
          {
            controlPlane: deps.controlPlane,
            resolver: deps.backend.resolver,
            metrics: deps.metrics,
            wakeWaitSeconds: deps.wakeWaitSeconds,
            wakePollMs: deps.wakePollMs,
            now: clock ? () => clock().getTime() : undefined,
          },
          {
            certificate: certificateLineOf(outcome.certificate),
            sourceIp: info.ip,
            agentId: outcome.username,
            endConnection: () => client.end(),
          },
        );
        sessions.add(session);
      }
    });

    client.on("session", (accept, reject) => {
      const live = session;
      if (!live) {
        reject();
        return;
      }
      handleSshSession(client, live, accept());
    });

    client.on("close", () => {
      clearTimeout(preauthTimer);
      release();
      connections.delete(client);
      const live = session;
      if (live) {
        sessions.delete(live);
        void live.close(CLOSE_CLIENT_DISCONNECT);
      }
    });
  };

  const server = new Server(
    {
      hostKeys: [deps.hostKey],
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
    },
    handleConnection,
  );

  return {
    listen(port, host = "0.0.0.0") {
      return new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const address: AddressInfo | string | null = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("listener bound without a TCP address"));
            return;
          }
          resolve(address.port);
        });
      });
    },

    liveSessions() {
      return sessions.size;
    },

    async drain(banner) {
      await new Promise<void>((resolve) => {
        // close() stops the listener; existing connections drain below.
        server.close(() => resolve());
        // With zero connections close() calls back immediately; with some it
        // waits for them — resolve as soon as the listener is down instead.
        setImmediate(resolve);
      });
      await Promise.allSettled(
        [...sessions].map((session) => session.close(CLOSE_SHUTDOWN, banner)),
      );
      for (const client of connections) client.end();
    },

    async close() {
      await this.drain("the server is shutting down, reconnect shortly");
    },
  };
};
