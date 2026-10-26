import { randomBytes } from "node:crypto";
import { Duplex } from "node:stream";
import {
  PORT_CHUNK_RAW_BYTES,
  PORT_STREAM_WINDOW_BYTES,
  type SupervisorMessage,
  type WorkItem,
} from "@onecli/agent-protocol";

/**
 * Sandbox ports, runner half (plans/sandbox-ports.md §7, §11.3).
 *
 * The runner owns every sandbox's supervisor socket, so it is the only place
 * a byte stream to a guest port can be multiplexed. It does ONLY byte
 * forwarding and per-sandbox caps; all HTTP semantics (auth, header strip,
 * error pages) live in the preview relay, a separate Deployment that reaches
 * this hub over an internal authenticated stream API.
 *
 * A stream is exposed as a Node `Duplex`: whatever the relay pipes in rides
 * `port.data` frames (credit-gated by the supervisor's `port.ack`s), and
 * guest bytes surface as readable data (backpressure turned into acks: we
 * grant the supervisor more window only as the consumer drains).
 */

type PortMessage = Extract<
  SupervisorMessage,
  {
    kind:
      | "port.opened"
      | "port.data"
      | "port.ack"
      | "port.close"
      | "port.error";
  }
>;

export const PORT_MESSAGE_KINDS = new Set<SupervisorMessage["kind"]>([
  "port.opened",
  "port.data",
  "port.ack",
  "port.close",
  "port.error",
]);

/** Narrows a supervisor frame to the port family (test harnesses route on
 * it; the runner's message handler switches on `kind` directly). */
export const isPortMessage = (m: SupervisorMessage): m is PortMessage =>
  PORT_MESSAGE_KINDS.has(m.kind);

export type PortOpenErrorCode =
  | "not_allowed"
  | "not_listening"
  | "limit"
  | "duplicate"
  | "failed"
  | "no_sandbox"
  | "timeout";

export class PortOpenError extends Error {
  constructor(readonly code: PortOpenErrorCode) {
    super(`port open failed: ${code}`);
  }
}

/** A supervisor that never answers (old image, wedged) must not hang a request. */
export const PORT_OPEN_TIMEOUT_MS = 10_000;
/** Runner-side cap per sandbox (the supervisor has its own belt). */
export const MAX_RUNNER_PORT_STREAMS_PER_SANDBOX = 32;

export interface PortHubOptions {
  /** Send a work item to the sandbox's supervisor; false if not connected. */
  sendToSandbox: (sandboxId: string, item: WorkItem) => boolean;
  openTimeoutMs?: number;
  maxStreamsPerSandbox?: number;
}

interface HubStream {
  sandboxId: string;
  duplex: PortDuplex;
  opened: boolean;
  settle?: {
    resolve: (d: Duplex) => void;
    reject: (e: PortOpenError) => void;
    timer: NodeJS.Timeout;
  };
}

class PortDuplex extends Duplex {
  /** Bytes we may still send toward the guest. */
  credit = PORT_STREAM_WINDOW_BYTES;
  /** Guest bytes pushed to the consumer but not yet acked to the supervisor. */
  unackedOut = 0;
  private pendingWrite?: { chunk: Buffer; cb: (e?: Error | null) => void };
  ended = false;

  constructor(
    private readonly emit_: (item: WorkItem) => void,
    readonly streamId: string,
    private readonly onDestroy: () => void,
  ) {
    super({ allowHalfOpen: true });
    // A guest-driven destroy (port.close abort) can land before any consumer
    // has subscribed. An unhandled 'error' event would crash the whole shared
    // runner, so one listener is always present. Consumers still see errors
    // through their own listeners and through close.
    this.on("error", () => undefined);
  }

  /** Called when the supervisor grants more window. */
  grant(bytes: number) {
    this.credit = Math.min(PORT_STREAM_WINDOW_BYTES, this.credit + bytes);
    const p = this.pendingWrite;
    if (p && this.credit > 0) {
      this.pendingWrite = undefined;
      this._write(p.chunk, "binary", p.cb);
    }
  }

  override _write(
    chunk: Buffer,
    _enc: BufferEncoding,
    cb: (e?: Error | null) => void,
  ) {
    let off = 0;
    while (off < chunk.length && this.credit > 0) {
      const n = Math.min(PORT_CHUNK_RAW_BYTES, this.credit, chunk.length - off);
      const part = chunk.subarray(off, off + n);
      this.credit -= n;
      this.emit_({
        kind: "port.data",
        streamId: this.streamId,
        dataBase64: part.toString("base64"),
      });
      off += n;
    }
    if (off < chunk.length) {
      // Window exhausted: hold the rest (and the callback, which is what
      // makes the upstream pipe apply backpressure) until the next ack.
      this.pendingWrite = { chunk: chunk.subarray(off), cb };
      return;
    }
    cb();
  }

  override _final(cb: (e?: Error | null) => void) {
    this.emit_({ kind: "port.close", streamId: this.streamId, mode: "end" });
    cb();
  }

  override _read() {
    // The consumer drained: grant the supervisor exactly what it has handed
    // us so far (the window refills as fast as the consumer reads, never
    // faster — that is the backpressure).
    if (this.unackedOut > 0) {
      const g = Math.min(this.unackedOut, PORT_STREAM_WINDOW_BYTES);
      this.unackedOut -= g;
      this.emit_({ kind: "port.ack", streamId: this.streamId, bytes: g });
    }
  }

  /** Guest bytes arrived. */
  deliver(bytes: Buffer) {
    this.unackedOut += bytes.length;
    // The supervisor runs beside agent code, so its credit discipline is not
    // trusted. Bytes are acked as they enter this stream's readable buffer
    // (below its high-water mark), so an honest guest can have at most that
    // buffer plus one full credit window outstanding here, plus one chunk of
    // slack. Past that the guest is ignoring credit, and the bytes would
    // only pile up in THIS shared runner's heap while a slow viewer reads:
    // cut the stream instead of buffering.
    if (
      this.readableLength + bytes.length >
      this.readableHighWaterMark +
        PORT_STREAM_WINDOW_BYTES +
        PORT_CHUNK_RAW_BYTES
    ) {
      this.destroy(new Error("guest exceeded the stream window"));
      return;
    }
    // push() returning false means the consumer's buffer is full: hold the
    // ack until _read() is called again.
    if (this.push(bytes)) this._read();
  }

  override _destroy(err: Error | null, cb: (e?: Error | null) => void) {
    this.pendingWrite?.cb(err ?? new Error("stream closed"));
    this.pendingWrite = undefined;
    this.onDestroy();
    cb(err);
  }
}

export interface PortHub {
  /** Open a byte stream to `port` inside `sandboxId`'s guest. */
  open(sandboxId: string, port: number): Promise<Duplex>;
  /** Route a supervisor port message (authenticated sandboxId). */
  handle(sandboxId: string, message: PortMessage): void;
  /** Push the approved-port allowlist to a sandbox. */
  setAllowed(sandboxId: string, ports: number[]): boolean;
  /** Drop every stream of a sandbox (its socket closed). */
  sandboxGone(sandboxId: string): void;
  /** Open streams, for one sandbox or in total (tests). */
  activeCount(sandboxId?: string): number;
}

export const createPortHub = (options: PortHubOptions): PortHub => {
  const {
    sendToSandbox,
    openTimeoutMs = PORT_OPEN_TIMEOUT_MS,
    maxStreamsPerSandbox = MAX_RUNNER_PORT_STREAMS_PER_SANDBOX,
  } = options;
  const streams = new Map<string, HubStream>();
  /** Open streams per sandbox: the cap is checked on every open, and a scan
   * of every stream per open would make a busy relay O(streams²). */
  const perSandbox = new Map<string, number>();

  const countFor = (sandboxId: string) => perSandbox.get(sandboxId) ?? 0;

  const track = (streamId: string, s: HubStream) => {
    streams.set(streamId, s);
    perSandbox.set(s.sandboxId, countFor(s.sandboxId) + 1);
  };

  const drop = (streamId: string) => {
    const s = streams.get(streamId);
    if (!s) return;
    streams.delete(streamId);
    const left = countFor(s.sandboxId) - 1;
    if (left > 0) perSandbox.set(s.sandboxId, left);
    else perSandbox.delete(s.sandboxId);
    if (s.settle) clearTimeout(s.settle.timer);
  };

  return {
    open(sandboxId, port) {
      if (countFor(sandboxId) >= maxStreamsPerSandbox) {
        return Promise.reject(new PortOpenError("limit"));
      }
      const streamId = randomBytes(12).toString("hex");
      const emit = (item: WorkItem) => {
        if (!sendToSandbox(sandboxId, item)) {
          streams
            .get(streamId)
            ?.duplex.destroy(new Error("sandbox disconnected"));
        }
      };
      const duplex = new PortDuplex(emit, streamId, () => {
        const s = streams.get(streamId);
        if (s?.opened && !s.duplex.ended) {
          // Consumer went away without a clean end: reset the guest side.
          sendToSandbox(sandboxId, {
            kind: "port.close",
            streamId,
            mode: "abort",
          });
        }
        drop(streamId);
      });
      return new Promise<Duplex>((resolve, reject) => {
        const timer = setTimeout(() => {
          drop(streamId);
          sendToSandbox(sandboxId, {
            kind: "port.close",
            streamId,
            mode: "abort",
          });
          reject(new PortOpenError("timeout"));
        }, openTimeoutMs);
        timer.unref?.();
        track(streamId, {
          sandboxId,
          duplex,
          opened: false,
          settle: { resolve, reject, timer },
        });
        if (!sendToSandbox(sandboxId, { kind: "port.open", streamId, port })) {
          drop(streamId);
          reject(new PortOpenError("no_sandbox"));
        }
      });
    },

    handle(sandboxId, message) {
      const s = streams.get(message.streamId);
      // A frame for a stream this sandbox does not own is ignored: the
      // authenticated sandboxId is the fence, never the payload's id alone.
      if (!s || s.sandboxId !== sandboxId) return;
      switch (message.kind) {
        case "port.opened": {
          if (s.opened || !s.settle) return;
          s.opened = true;
          clearTimeout(s.settle.timer);
          const { resolve } = s.settle;
          s.settle = undefined;
          resolve(s.duplex);
          return;
        }
        case "port.error": {
          if (s.opened || !s.settle) return;
          const { reject } = s.settle;
          drop(message.streamId);
          reject(new PortOpenError(message.code));
          return;
        }
        case "port.data":
          if (!s.opened) return;
          s.duplex.deliver(Buffer.from(message.dataBase64, "base64"));
          return;
        case "port.ack":
          s.duplex.grant(message.bytes);
          return;
        case "port.close":
          // Close before opened (a forged frame): fail the pending open
          // rather than tearing down a duplex nobody holds yet.
          if (!s.opened) {
            if (s.settle) {
              const { reject } = s.settle;
              drop(message.streamId);
              reject(new PortOpenError("failed"));
            }
            return;
          }
          if (message.mode === "end") {
            s.duplex.ended = true;
            s.duplex.push(null);
          } else {
            s.duplex.ended = true;
            s.duplex.destroy(new Error("guest reset the stream"));
          }
          return;
      }
    },

    setAllowed(sandboxId, ports) {
      return sendToSandbox(sandboxId, { kind: "ports.allow", ports });
    },

    sandboxGone(sandboxId) {
      for (const [id, s] of [...streams]) {
        if (s.sandboxId !== sandboxId) continue;
        if (s.settle) {
          const { reject } = s.settle;
          drop(id);
          reject(new PortOpenError("no_sandbox"));
        } else {
          s.duplex.ended = true;
          s.duplex.destroy(new Error("sandbox disconnected"));
        }
      }
    },

    activeCount(sandboxId) {
      return sandboxId ? countFor(sandboxId) : streams.size;
    },
  };
};
