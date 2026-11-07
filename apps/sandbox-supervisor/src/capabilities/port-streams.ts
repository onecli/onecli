import { connect, type Socket } from "node:net";
import {
  MAX_PORT_STREAMS_PER_SANDBOX,
  PORT_CHUNK_RAW_BYTES,
  PORT_STREAM_WINDOW_BYTES,
  type SupervisorMessage,
  type WorkItem,
} from "@onecli/agent-protocol";
import { log } from "../log";

/**
 * Sandbox ports, supervisor half (plans/sandbox-ports.md §7).
 *
 * The runner asks (`port.open`), this module dials `127.0.0.1:<port>` from
 * INSIDE the guest, and bytes ride the channel the supervisor already owns —
 * so the sandbox never accepts an inbound connection (invariant #1), and
 * where the substrate wraps the guest in another network namespace, that
 * outer layer is irrelevant.
 *
 * Laws:
 * - **Allowlist, fail closed.** Only ports in the latest `ports.allow` are
 *   dialable (the approved shares). Nothing is dialable before the first
 *   push. Platform-reserved ports are refused even if allowed (a runner or
 *   control-plane bug must not expose the supervisor's own sockets).
 * - **Bounded.** At most MAX_PORT_STREAMS_PER_SANDBOX streams; chunks at
 *   PORT_CHUNK_RAW_BYTES (the wire's frame bound); credit-based flow control
 *   in both directions so a fast service or a slow reader can't balloon
 *   memory: guest bytes pause (`socket.pause()`) when the runner's window is
 *   spent and resume on `port.ack`; runner bytes are acked only after the
 *   local socket accepted them.
 * - **Exactly one answer per open** (`port.opened` | `port.error`), and
 *   exactly one `port.close` per opened stream, whoever ends it.
 * - **Shrinking the allowlist kills streams** to ports no longer allowed —
 *   revoking a share must cut live connections, not just new ones.
 */

type OpenItem = Extract<WorkItem, { kind: "port.open" }>;
type DataItem = Extract<WorkItem, { kind: "port.data" }>;
type AckItem = Extract<WorkItem, { kind: "port.ack" }>;
type CloseItem = Extract<WorkItem, { kind: "port.close" }>;
type AllowItem = Extract<WorkItem, { kind: "ports.allow" }>;
export type PortWorkItem =
  | OpenItem
  | DataItem
  | AckItem
  | CloseItem
  | AllowItem;

export const PORT_WORK_KINDS = new Set<WorkItem["kind"]>([
  "port.open",
  "port.data",
  "port.ack",
  "port.close",
  "ports.allow",
]);

export const isPortWorkItem = (item: WorkItem): item is PortWorkItem =>
  PORT_WORK_KINDS.has(item.kind);

/** Dial budget: loopback either answers or refuses instantly; a hang means a
 * wedged service, which should surface as an error page, not a spinner. */
export const PORT_DIAL_TIMEOUT_MS = 5_000;

/**
 * Guest ports the platform will never dial, whatever the allowlist says.
 * The supervisor dials out and storage and SSH are handled outside the
 * guest. The one platform socket inside the guest is the open proxy
 * (open-proxy.ts), whose port is only known at boot, so it is added by
 * {@link reservedGuestPorts}. SSH (22) is listed because an agent-started
 * sshd would be a credential surface that must go through the owner-only
 * SSH path, never a preview.
 */
export const SUPERVISOR_RESERVED_PORTS: ReadonlySet<number> = new Set([22]);

/**
 * The static reserved set plus the port the open proxy actually bound
 * (`OPEN_PROXY`, e.g. `http://127.0.0.1:3128`). That listener is a door onto
 * the gateway's open lane, so sharing it as a preview would hand the
 * internet the agent's egress. Unparseable or absent values add nothing.
 */
export const reservedGuestPorts = (
  openProxyUrl: string | undefined,
): ReadonlySet<number> => {
  const reserved = new Set(SUPERVISOR_RESERVED_PORTS);
  if (openProxyUrl) {
    try {
      const port = Number(new URL(openProxyUrl).port);
      if (Number.isInteger(port) && port > 0) reserved.add(port);
    } catch {
      // Not a URL: nothing to reserve.
    }
  }
  return reserved;
};

interface Stream {
  port: number;
  socket: Socket;
  /** Bytes we may still send to the runner before waiting for its ack. */
  sendCredit: number;
  opened: boolean;
  /** Fully torn down and removed from the map. */
  closed: boolean;
  /** The runner half-closed (it sent `port.close end`): no more inbound. */
  runnerEnded: boolean;
  /** We already told the runner the guest side ended (`port.close end`). */
  guestEndSent: boolean;
  /** Bytes the local socket accepted since our last ack to the runner. */
  unackedInbound: number;
  /** A coalesced ack is already queued for this tick. */
  ackScheduled: boolean;
  /** Guest bytes read but not yet sendable (window exhausted). */
  parked?: Buffer;
  /** The guest FIN arrived while bytes were parked. */
  guestEndPending: boolean;
}

export interface PortStreamsOptions {
  send: (message: SupervisorMessage) => void;
  /** Ports that may never be dialed (the supervisor's own listeners etc.). */
  reservedPorts?: ReadonlySet<number>;
  /** Test seam. */
  dial?: (port: number) => Socket;
  maxStreams?: number;
}

export interface PortStreams {
  /** Handle a port work item — called INLINE from the reader loop (a stream
   * must never queue behind a running turn). */
  handle(item: PortWorkItem): void;
  /** Currently open stream count (tests). */
  activeCount(): number;
  /** Abort every stream (shutdown). */
  close(): void;
}

export const createPortStreams = (options: PortStreamsOptions): PortStreams => {
  const {
    send,
    reservedPorts = new Set<number>(),
    dial = (port) => connect({ host: "127.0.0.1", port }),
    maxStreams = MAX_PORT_STREAMS_PER_SANDBOX,
  } = options;

  let allowed = new Set<number>();
  const streams = new Map<string, Stream>();

  /**
   * Tear a stream down. `notifyAbort`: tell the runner it was reset (only if
   * it opened and we haven't already reported a clean guest end). Half-close
   * is NOT teardown: see `runnerEnd` / the socket 'end' handler — HTTP needs
   * the response to flow after the request side has finished.
   */
  const teardown = (streamId: string, notifyAbort: boolean) => {
    const s = streams.get(streamId);
    if (!s || s.closed) return;
    s.closed = true;
    streams.delete(streamId);
    s.socket.destroy();
    if (notifyAbort && s.opened && !s.guestEndSent) {
      send({ kind: "port.close", streamId, mode: "abort" });
    }
  };

  /** The runner finished sending: half-close toward the guest, keep reading. */
  const runnerEnd = (streamId: string) => {
    const s = streams.get(streamId);
    if (!s || s.closed || s.runnerEnded) return;
    s.runnerEnded = true;
    s.socket.end();
    if (s.guestEndSent) teardown(streamId, false);
  };

  const pumpGuestBytes = (streamId: string, s: Stream, chunk: Buffer) => {
    // Never exceed the granted window: send what credit allows (chunked to
    // the wire bound), park the remainder, pause the socket. The remainder is
    // flushed first on the next ack, so order is preserved.
    let data = s.parked ? Buffer.concat([s.parked, chunk]) : chunk;
    s.parked = undefined;
    while (data.length > 0 && s.sendCredit > 0) {
      const n = Math.min(PORT_CHUNK_RAW_BYTES, s.sendCredit, data.length);
      const part = data.subarray(0, n);
      s.sendCredit -= n;
      send({
        kind: "port.data",
        streamId,
        dataBase64: part.toString("base64"),
      });
      data = data.subarray(n);
    }
    if (data.length > 0) {
      s.parked = Buffer.from(data);
      s.socket.pause();
    } else if (s.sendCredit <= 0) {
      s.socket.pause();
    }
    // A guest FIN that arrived while bytes were parked is reported only once
    // they have all been sent.
    if (!s.parked && s.guestEndPending) {
      s.guestEndPending = false;
      reportGuestEnd(streamId, s);
    }
  };

  const reportGuestEnd = (streamId: string, s: Stream) => {
    if (s.closed || s.guestEndSent) return;
    s.guestEndSent = true;
    if (s.opened) send({ kind: "port.close", streamId, mode: "end" });
    if (s.runnerEnded) teardown(streamId, false);
  };

  const open = (item: OpenItem) => {
    const { streamId, port } = item;
    if (streams.has(streamId)) {
      send({ kind: "port.error", streamId, code: "duplicate" });
      return;
    }
    if (reservedPorts.has(port) || !allowed.has(port)) {
      send({ kind: "port.error", streamId, code: "not_allowed" });
      return;
    }
    if (streams.size >= maxStreams) {
      send({ kind: "port.error", streamId, code: "limit" });
      return;
    }

    const socket = dial(port);
    const s: Stream = {
      port,
      socket,
      sendCredit: PORT_STREAM_WINDOW_BYTES,
      opened: false,
      closed: false,
      runnerEnded: false,
      guestEndSent: false,
      unackedInbound: 0,
      ackScheduled: false,
      guestEndPending: false,
    };
    streams.set(streamId, s);
    // allowHalfOpen: the guest ending its side must not auto-end ours.
    socket.allowHalfOpen = true;
    socket.setNoDelay(true);
    socket.setTimeout(PORT_DIAL_TIMEOUT_MS);

    socket.once("connect", () => {
      socket.setTimeout(0);
      if (s.closed) return;
      s.opened = true;
      send({ kind: "port.opened", streamId });
    });
    socket.on("timeout", () => {
      // Only the dial is timed (cleared on connect); an idle open stream is
      // the relay's business, not ours.
      if (!s.opened) {
        streams.delete(streamId);
        s.closed = true;
        socket.destroy();
        send({ kind: "port.error", streamId, code: "failed" });
      }
    });
    socket.on("data", (chunk: Buffer) => {
      if (s.closed) return;
      pumpGuestBytes(streamId, s, chunk);
    });
    socket.on("end", () => {
      // Guest half-closed. If bytes are still parked behind the window, the
      // end is reported after they flush (never before the data it follows).
      if (s.closed || s.guestEndSent) return;
      if (s.parked) {
        s.guestEndPending = true;
        return;
      }
      reportGuestEnd(streamId, s);
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (!s.opened && !s.closed) {
        streams.delete(streamId);
        s.closed = true;
        send({
          kind: "port.error",
          streamId,
          code: err.code === "ECONNREFUSED" ? "not_listening" : "failed",
        });
        return;
      }
      log("warn", "port stream socket error", { port, error: String(err) });
      teardown(streamId, true);
    });
    // Fully closed: a clean close after both ends is silent; anything else
    // (reset, destroy) is reported as an abort.
    socket.on("close", () => teardown(streamId, true));
  };

  const data = (item: DataItem) => {
    const s = streams.get(item.streamId);
    if (!s || s.closed || !s.opened || s.runnerEnded) return;
    const bytes = Buffer.from(item.dataBase64, "base64");
    // Ack once the local socket has taken the bytes (write callback), so the
    // runner's in-flight window tracks what the guest service actually
    // drained. Grants coalesce per tick: a burst of frames earns one ack, and
    // a lone small request is acked promptly (never waits for a threshold —
    // that would stall request/response forever).
    s.socket.write(bytes, (err) => {
      if (err || s.closed) return;
      s.unackedInbound += bytes.length;
      if (s.ackScheduled) return;
      s.ackScheduled = true;
      setImmediate(() => {
        s.ackScheduled = false;
        if (s.closed || s.unackedInbound === 0) return;
        const grant = Math.min(s.unackedInbound, PORT_STREAM_WINDOW_BYTES);
        s.unackedInbound -= grant;
        send({ kind: "port.ack", streamId: item.streamId, bytes: grant });
      });
    });
  };

  const ack = (item: AckItem) => {
    const s = streams.get(item.streamId);
    if (!s || s.closed) return;
    s.sendCredit = Math.min(
      PORT_STREAM_WINDOW_BYTES,
      s.sendCredit + item.bytes,
    );
    if (s.parked) pumpGuestBytes(item.streamId, s, Buffer.alloc(0));
    if (!s.parked && s.sendCredit > 0 && s.socket.isPaused()) s.socket.resume();
  };

  const setAllowed = (ports: number[]) => {
    allowed = new Set(ports);
    for (const [streamId, s] of streams) {
      if (!allowed.has(s.port)) teardown(streamId, true);
    }
  };

  return {
    handle(item) {
      switch (item.kind) {
        case "port.open":
          return open(item);
        case "port.data":
          return data(item);
        case "port.ack":
          return ack(item);
        case "port.close":
          // The runner ended or reset it: never echoed back.
          if (item.mode === "end") return runnerEnd(item.streamId);
          return teardown(item.streamId, false);
        case "ports.allow":
          return setAllowed(item.ports);
      }
    },
    activeCount: () => streams.size,
    close() {
      for (const streamId of [...streams.keys()]) teardown(streamId, true);
    },
  };
};
