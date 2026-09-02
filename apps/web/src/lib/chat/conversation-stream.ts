import type { TurnEvent } from "@/lib/api/types";
import { conversationPath } from "@/lib/api/conversations";
import { initialSseState, parseTranscriptFrame, pushSseChunk } from "./sse";

/**
 * The stream's connect/read/reconnect engine, pure over an injected fetch so
 * every lifecycle decision is node-testable. Reconnection is the normal state
 * of this protocol, not an exception: the ALB recycles healthy connections by
 * design, and the server deliberately cuts slow readers — so the engine
 * retries forever on anything transient and stops only when the server
 * refuses for good.
 */

export type StreamStatus =
  /** No conversation selected. */
  | "idle"
  /** First connect, nothing received yet. */
  | "connecting"
  /** Response open, bytes flowing. */
  | "streaming"
  /** A connection ended or failed; a retry is scheduled or in flight. */
  | "reconnecting"
  /** Refused for good (4xx) — the engine will not retry. */
  | "error";

export interface StreamFatalError {
  httpStatus?: number;
  message: string;
}

export interface StreamCallbacks {
  /** One call per network read that produced at least one transcript event. */
  onEvents: (incoming: TurnEvent[]) => void;
  onStatus: (status: StreamStatus, error?: StreamFatalError) => void;
}

export interface StreamDeps {
  /**
   * `apiFetch` in production; scripted in tests. Called fresh per attempt so
   * auth headers are re-derived — a long-lived tab survives token refresh.
   */
  fetchStream: (path: string, signal: AbortSignal) => Promise<Response>;
  /** The highest `seq` the caller holds — read at each (re)connect. */
  getCursor: () => number;
  /** Injectable for tests. */
  delayMs?: (attempt: number) => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  readLivenessMs?: number;
}

/**
 * 4xx = the server meant it: stop. Except the retryable trio — 408/429 by
 * convention, and 401 because on cloud a transient token-refresh failure
 * sends one request with no Authorization header at all; killing a live
 * thread over it would turn a laptop wake into a full-screen error. Real
 * auth loss surfaces through every other query anyway.
 */
export const isFatalStatus = (status: number): boolean =>
  status >= 400 &&
  status < 500 &&
  status !== 401 &&
  status !== 408 &&
  status !== 429;

/** 500ms, 1s, 2s, 4s, 8s, 16s, 30s cap — ±25% jitter. */
export const reconnectDelayMs = (attempt: number): number => {
  const base = Math.min(30_000, 500 * 2 ** Math.min(attempt - 1, 6));
  return Math.round(base * (0.75 + Math.random() * 0.5));
};

/**
 * A connection that delivered bytes and lived this long resets the backoff,
 * so a routine cut resumes in ~500ms — while the floor stops a server that is
 * only ever briefly healthy from defeating the backoff entirely.
 */
const HEALTHY_CONNECTION_MS = 10_000;

/**
 * The server writes a keep-alive comment every 15s, precisely so a reader
 * can tell a quiet stream from a dead TCP path (NAT rebind, AP switch,
 * sleep/wake) that will never error. Three missed heartbeats = stalled.
 */
const READ_LIVENESS_MS = 45_000;

/** Sentinel resolved by a read that outlived the liveness window. */
const STALLED = Symbol("stalled");

const readWithLiveness = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<ReadableStreamReadResult<Uint8Array> | typeof STALLED> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(STALLED), ms);
    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (cause) => {
        clearTimeout(timer);
        reject(cause as Error);
      },
    );
  });

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * Run the stream until aborted (resolves silently) or refused for good
 * (`onStatus("error")`, then resolves). Never rejects. `signal.aborted` is
 * checked after every await BEFORE any callback — that silence is what makes
 * an overlapping StrictMode mount unable to corrupt its successor's state.
 */
export const runConversationStream = async (
  conversationId: string,
  deps: StreamDeps,
  cb: StreamCallbacks,
  signal: AbortSignal,
): Promise<void> => {
  const delayMs = deps.delayMs ?? reconnectDelayMs;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const readLivenessMs = deps.readLivenessMs ?? READ_LIVENESS_MS;

  let attempt = 0; // consecutive failures
  let connectedOnce = false;

  // Deduped so eager emits (reconnecting before the backoff sleep) and the
  // loop-top emit don't produce noisy repeats; an error always goes through.
  let lastStatus: StreamStatus | undefined;
  const emit = (status: StreamStatus, error?: StreamFatalError) => {
    if (status !== lastStatus || error) {
      lastStatus = status;
      cb.onStatus(status, error);
    }
  };

  const backoff = async () => {
    attempt += 1;
    await sleep(delayMs(attempt), signal);
  };

  const discard = (res: Response) => {
    void res.body?.cancel().catch(() => undefined);
  };

  for (;;) {
    if (signal.aborted) return;
    emit(connectedOnce ? "reconnecting" : "connecting");

    const cursor = deps.getCursor();
    const path =
      conversationPath(conversationId, "/stream") +
      (cursor > 0 ? `?since=${cursor}` : "");

    // ── Phase 1: the HTTP response — where refusals are distinguishable ──
    let res: Response;
    try {
      res = await deps.fetchStream(path, signal);
    } catch {
      if (signal.aborted) return; // deliberate teardown, not a failure
      await backoff();
      continue;
    }
    if (signal.aborted) return;

    if (!res.ok) {
      discard(res);
      if (isFatalStatus(res.status)) {
        // A 404 after deletion, a 403 — looping would hammer a request
        // that can only refuse again.
        emit("error", {
          httpStatus: res.status,
          message: `Stream refused with ${res.status}`,
        });
        return;
      }
      await backoff(); // 5xx / 401 / 408 / 429: transient
      continue;
    }

    // A 200 that is not SSE is a proxy interposing (login portal, buffering
    // middlebox) — a failed attempt, not a stream to parse.
    if (
      !res.body ||
      !(res.headers.get("content-type") ?? "").includes("text/event-stream")
    ) {
      discard(res);
      await backoff();
      continue;
    }

    // ── Phase 2: the read loop — everything here is retryable ──
    connectedOnce = true;
    emit("streaming");
    const openedAt = now();
    let sawBytes = false;

    // Per-connection, never reused: an abort mid-frame leaves a partial
    // buffer that would corrupt the next connection's first frame.
    let parser = initialSseState;
    const decoder = new TextDecoder();
    const reader = res.body.getReader();

    try {
      for (;;) {
        const result = await readWithLiveness(reader, readLivenessMs);
        if (signal.aborted) return; // guard BEFORE any callback
        if (result === STALLED) {
          // Silence past the heartbeat window: the path is dead even though
          // the socket never errored. Cut our end and reconnect.
          void reader.cancel().catch(() => undefined);
          break;
        }
        if (result.done) break; // server closed (overflow, ALB, stall cut)
        sawBytes = true; // keepalives count: liveness is bytes

        const pushed = pushSseChunk(
          parser,
          decoder.decode(result.value, { stream: true }),
        );
        parser = pushed.state;
        const events: TurnEvent[] = [];
        for (const frame of pushed.frames) {
          const event = parseTranscriptFrame(frame);
          if (event) events.push(event);
        }
        if (events.length > 0) cb.onEvents(events); // ONE delivery per read
      }
    } catch {
      if (signal.aborted) return; // AbortError from teardown: silence
    }

    // Say so BEFORE the backoff sleep — a cut tail must not keep reading
    // "streaming" for up to 30s while the retry waits.
    emit("reconnecting");
    const healthy = sawBytes && now() - openedAt >= HEALTHY_CONNECTION_MS;
    if (healthy) {
      attempt = 1;
      await sleep(delayMs(attempt), signal);
    } else {
      await backoff();
    }
  }
};
