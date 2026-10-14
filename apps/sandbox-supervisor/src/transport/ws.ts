import {
  SESSION_RESUME_BUDGET,
  workItemSchema,
  type SequencedFrame,
  type SupervisorMessage,
  type SupervisorTransport,
  type SupervisorWorkItem,
} from "@onecli/agent-protocol";
import { log } from "../log";

/**
 * The WebSocket transport driver: the sandbox dials its runner over the
 * container network (§3.3 — the sandbox never talks to the control plane).
 * Same seam as the stdio driver, same laws — malformed frames are dropped
 * rather than fatal, `shutdown` is delivered and then ends the stream, and
 * `send` stays synchronous, so outbound messages are buffered until the
 * socket is open.
 *
 * No dependency: Node 22 ships a WHATWG `WebSocket` client, so the agent
 * image gains nothing to install.
 */

/**
 * Retry budget: generous enough to outlive any real runner outage (with the
 * backoff capped at 15s this is roughly a quarter of an hour), and finite on
 * purpose.
 *
 * Infinite retry looks safer and is not. A sandbox whose runner is genuinely
 * gone — the control plane was torn down, the host was rebuilt — would sit
 * there dialling a socket nobody answers for the life of the container,
 * holding its memory and its home volume, invisible to a reconcile that
 * only recognises objects labelled by the CURRENT runner. Giving up ends the
 * process, which stops the container, which is the state an operator can
 * actually see and clean up.
 */
export const DEFAULT_MAX_ATTEMPTS = SESSION_RESUME_BUDGET.maxAttempts;

/**
 * How many messages may queue while the channel is down. The control plane's
 * history is authoritative, so an old dropped event costs a reconnect, never
 * correctness — whereas an unbounded queue costs the container.
 */
export const MAX_OUTBOUND_MESSAGES = 2_000;

/**
 * Longest `close()` waits for the socket to acknowledge. Bounded because the
 * alternative to a half-open socket noticing is a container that never exits.
 */
export const CLOSE_TIMEOUT_MS = 2_000;

export interface WsTransportOptions {
  url: string;
  /** Single-use bootstrap token minted by the runner for this sandbox. */
  token: string;
  /**
   * This sandbox's id, presented beside a session credential on reconnect so
   * the runner knows which container to verify it against. Never trusted
   * for attribution: the runner attributes by the credential it verifies.
   */
  sandboxId: string;
  /** Injectable for tests; defaults to the global WebSocket. */
  socketFactory?: (url: string) => WebSocket;
  /** Reconnect backoff bounds. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /**
   * How many consecutive failures before the sandbox gives up and exits.
   * Default is generous but FINITE — see the constant below.
   */
  maxAttempts?: number;
}

/** A promise plus the handles to settle it — one queue slot for `incoming`. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

export const createWsTransport = (
  options: WsTransportOptions,
): SupervisorTransport => {
  const {
    url,
    token,
    sandboxId,
    socketFactory = (target) => new WebSocket(target),
    minBackoffMs = SESSION_RESUME_BUDGET.minBackoffMs,
    maxBackoffMs = SESSION_RESUME_BUDGET.maxBackoffMs,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
  } = options;

  const separator = url.includes("?") ? "&" : "?";
  const bootstrapTarget = `${url}${separator}token=${encodeURIComponent(token)}`;

  /**
   * THE RESUMABLE SESSION. Handed over by the runner on every successful
   * connect (`session` work item), consumed here and never surfaced to the
   * supervisor loop: it is a transport fact. While held, every connect
   * presents it instead of the (spent) bootstrap token, every outbound
   * frame is numbered, and the buffer below keeps frames until the runner
   * ACKS them rather than until they are merely sent.
   */
  let session: string | undefined;
  /**
   * A refused session (the key rotated away, the container was recreated
   * under us) falls back to the bootstrap token exactly once: if the runner
   * is the same process that minted it, the token is spent and the ordinary
   * finite budget ends things; if a brand-new sandbox start is under way,
   * the recreate makes this process irrelevant anyway.
   */
  let bootstrapFallbackUsed = false;
  /** Monotonic per process; a frame keeps its seq for life, replays included. */
  let nextSeq = 0;

  let socket: WebSocket | undefined;
  /** No more reconnects: a shutdown arrived or we gave up. */
  let closed = false;
  /** No more items will ever arrive — `incoming` may finish its queue and end. */
  let ended = false;
  let attempts = 0;
  /** One line per outage, not one per dropped message. */
  let warnedOutbound = false;
  /**
   * Messages produced before the socket opened, sent in order once it does.
   *
   * BOUNDED, because the sandbox keeps working while the channel is down: a
   * tool-heavy turn would buffer megabytes for the whole retry budget inside
   * a container capped at a couple of gigabytes, then discard the lot.
   * Dropping the oldest keeps the newest, which is what a reader
   * reconnecting from history actually needs.
   *
   * Without a session a frame waits only until the socket is open (sent =
   * gone), as before. With one, every frame is numbered and STAYS queued
   * until the runner acks it, so a reconnect replays the unacked tail.
   * Un-numbered frames queued before the session arrived are sent once and
   * never replayed: the runner that receives them is the one that handed
   * the session over.
   */
  const outbound: Array<{ seq: number | undefined; raw: string }> = [];
  const inbound: SupervisorWorkItem[] = [];
  let pending:
    | ReturnType<typeof deferred<SupervisorWorkItem | null>>
    | undefined;

  const deliver = (item: SupervisorWorkItem | null) => {
    if (item === null) ended = true;
    if (pending) {
      const waiter = pending;
      pending = undefined;
      waiter.resolve(item);
      return;
    }
    if (item) inbound.push(item);
  };

  /**
   * Write cursor for the CURRENT socket: the highest numbered frame written
   * to it. Set from the runner's hand-off on every connect (its ack) and
   * nowhere else, so a fresh socket replays exactly what the runner lacks.
   */
  let sentUpTo = 0;

  const flush = () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (session === undefined) {
      while (outbound.length > 0) {
        const next = outbound.shift();
        if (next !== undefined) socket.send(next.raw);
      }
      return;
    }
    for (const entry of outbound) {
      if (entry.seq === undefined) {
        socket.send(entry.raw);
      } else if (entry.seq > sentUpTo) {
        socket.send(entry.raw);
        sentUpTo = entry.seq;
      }
    }
    for (let i = outbound.length - 1; i >= 0; i -= 1) {
      if (outbound[i]!.seq === undefined) outbound.splice(i, 1);
    }
  };

  /** Drop every acked frame: the runner has applied them. */
  const acknowledge = (ack: number) => {
    let acked = 0;
    while (acked < outbound.length) {
      const seq = outbound[acked]!.seq;
      if (seq === undefined || seq > ack) break;
      acked += 1;
    }
    if (acked > 0) outbound.splice(0, acked);
  };

  /**
   * Reconnect is driven from BOTH `error` and `close`, because neither one
   * alone is reliable: a socket that fails to establish at all emits `error`
   * and then — depending on how the connection failed — may never emit
   * `close`. Scheduling only from `close` means the retry chain dies after
   * the first failed attempt, which is precisely when it is needed (the
   * runner is mid-restart, so the first attempt is the one that fails).
   *
   * The timer handle doubles as the guard: whichever event arrives first
   * schedules, the other sees a pending timer and does nothing.
   */
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer) return;
    if (attempts >= maxAttempts) {
      log("error", "runner channel gave up reconnecting");
      closed = true;
      deliver(null);
      return;
    }
    // `attempts` is 0 on the first retry after a successful open, and
    // 2 ** -1 would make the first backoff half the stated minimum.
    const delay = Math.min(
      Math.max(minBackoffMs, minBackoffMs * 2 ** (attempts - 1)),
      maxBackoffMs,
    );
    log("warn", "runner channel down; reconnecting", { delay });
    // NOT unref'd, and that is the whole point. While the socket is down this
    // timer is the ONLY thing holding the event loop open: the reader is
    // parked on a promise, and a pending promise does not keep Node alive.
    // Unref it and the process exits — cleanly, code 0 — in the milliseconds
    // before the reconnect fires, so a runner restart kills every sandbox on
    // the host while the control plane goes on believing they run.
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  const target = (): string => {
    if (session === undefined) return bootstrapTarget;
    return `${url}${separator}session=${encodeURIComponent(session)}&sandbox=${encodeURIComponent(sandboxId)}`;
  };

  const connect = (): void => {
    if (closed) return;
    attempts += 1;
    const ws = socketFactory(target());
    socket = ws;

    // Every handler below belongs to THIS socket. A superseded one must not
    // touch shared state: its `open` would reset the retry budget for a
    // connection nobody is using (defeating the bound entirely), its `close`
    // would schedule a second live socket, and its `message` would deliver
    // work over a channel the runner no longer sends on. The pending-timer
    // guard does not cover this — it is cleared before `connect()` runs.
    const isCurrent = () => socket === ws;

    let opened = false;
    ws.addEventListener("open", () => {
      if (!isCurrent()) return;
      opened = true;
      attempts = 0;
      warnedOutbound = false;
      log("info", "runner channel open", { resumed: session !== undefined });
      // With a session, the replay waits for the runner's hand-off (its
      // cursor decides what to resend); without one, drain as before.
      if (session === undefined) flush();
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      if (!isCurrent()) return;
      const raw =
        typeof event.data === "string" ? event.data : String(event.data);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        log("warn", "ws transport: dropping non-JSON frame");
        return;
      }
      const item = workItemSchema.safeParse(parsed);
      if (!item.success) {
        log("warn", "ws transport: dropping invalid work item", {
          issue: item.error.issues[0]?.message,
        });
        return;
      }
      // The two transport-level items. Neither reaches the supervisor loop.
      if (item.data.kind === "session") {
        const resumed = session !== undefined;
        session = item.data.credential;
        bootstrapFallbackUsed = false;
        // The runner's cursor is the truth about what it holds (a process
        // that restarted says 0): everything it acked is dropped, and the
        // write cursor for this socket starts there, so exactly the gap
        // replays. The one place the cursor is set.
        acknowledge(item.data.ack);
        sentUpTo = item.data.ack;
        log(
          "info",
          resumed ? "runner session resumed" : "runner session held",
          {
            ack: item.data.ack,
            pending: outbound.length,
          },
        );
        flush();
        return;
      }
      if (item.data.kind === "ack") {
        acknowledge(item.data.seq);
        return;
      }
      deliver(item.data);
      if (item.data.kind === "shutdown") closed = true;
    });

    // A failed connect may raise only this — no `close` follows — so the
    // retry has to be driven from here as well.
    ws.addEventListener("error", () => {
      if (!isCurrent()) return;
      log("warn", "runner channel error");
      scheduleReconnect();
    });

    ws.addEventListener("close", () => {
      if (!isCurrent()) return;
      if (closed) {
        deliver(null);
        return;
      }
      // A session that was presented and never opened was refused. Try the
      // bootstrap token once (see `bootstrapFallbackUsed`), then let the
      // ordinary budget decide.
      if (session !== undefined && !opened && !bootstrapFallbackUsed) {
        log(
          "warn",
          "runner session refused; retrying with the bootstrap token",
        );
        session = undefined;
        bootstrapFallbackUsed = true;
      }
      scheduleReconnect();
    });
  };

  connect();

  return {
    async *incoming(): AsyncIterable<SupervisorWorkItem> {
      for (;;) {
        const queued = inbound.shift();
        if (queued) {
          yield queued;
          if (queued.kind === "shutdown") return;
          continue;
        }
        if (ended) return;
        pending = deferred<SupervisorWorkItem | null>();
        const next = await pending.promise;
        if (!next) return;
        yield next;
        if (next.kind === "shutdown") return;
      }
    },

    send(message: SupervisorMessage): void {
      // Liveness heartbeats are only worth anything fresh: a beat that would
      // sit in a dead channel's backlog is stale on arrival, and a long
      // outage's worth of them would flood the runner's report queue on
      // reconnect — racing the very `turn.result` frames the backlog exists
      // to preserve. Every other kind still buffers; the next timer tick
      // re-beats within a minute of the channel coming back.
      if (
        message.kind === "progress" &&
        (!socket || socket.readyState !== WebSocket.OPEN)
      ) {
        return;
      }
      if (session === undefined) {
        outbound.push({ seq: undefined, raw: JSON.stringify(message) });
      } else {
        nextSeq += 1;
        const frame: SequencedFrame = { seq: nextSeq, message };
        outbound.push({ seq: nextSeq, raw: JSON.stringify(frame) });
      }
      if (outbound.length > MAX_OUTBOUND_MESSAGES) {
        const dropped = outbound.length - MAX_OUTBOUND_MESSAGES;
        outbound.splice(0, dropped);
        if (!warnedOutbound) {
          warnedOutbound = true;
          log("warn", "control channel backlog full; dropping oldest events", {
            cap: MAX_OUTBOUND_MESSAGES,
          });
        }
      }
      flush();
    },

    close(): Promise<void> {
      // Everything `send` was given has already reached the socket — it writes
      // through whenever the socket is open, and buffers only while it is not,
      // in which case there is nothing to flush to. So this only has to stop
      // the reconnect, end the reader, and release the handle.
      //
      // What protects the LAST messages is the call site, not this method: the
      // supervisor closes after its in-flight turns have reported, so the
      // `unhealthy` report and a dying turn's result are already out.
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      deliver(null);

      const ws = socket;
      if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          log("warn", "runner channel did not close in time");
          resolve();
        }, CLOSE_TIMEOUT_MS);
        // Unref'd: this timer must never be the thing keeping a container
        // alive — unlike the reconnect timer, whose job is exactly that.
        timer.unref?.();
        ws.addEventListener("close", done, { once: true });
        ws.close();
      });
    },
  };
};
