import { connectionsOpen, SlackApiError } from "./client";

/**
 * One Socket Mode connection: `apps.connections.open` → a wss URL → an
 * outbound WebSocket carrying JSON envelopes that MUST each be acked (or
 * Slack redelivers, then disconnects).
 *
 * Built on Node ≥22's global WebSocket — no dependency — with the reconnect
 * machinery `apps/sandbox-supervisor/src/transport/ws.ts` already paid for:
 * BOTH `error` and `close` drive the retry (a socket that never establishes
 * emits `error` and may never emit `close`); every handler checks it belongs
 * to the CURRENT socket (a stale socket's close must not clobber its
 * replacement); the reconnect timer is deliberately NOT unref'd while the
 * link is down (it is the only thing holding the loop open in a quiet
 * process).
 *
 * Slack-specific lifecycle: a `disconnect` frame with reason `warning` or
 * `refresh_requested` means "this link is about to die — dial a fresh one"
 * (roughly hourly by design); `link_disabled` and an `invalid_auth` refusal
 * from `apps.connections.open` are PERMANENT — the owner (the reconcile
 * loop) is told and retries only when config changes.
 */

/** Ack immediately on receipt, process async — Slack's 3s rule, and the
 * at-least-once dedupe lives control-plane-side. */
interface Envelope {
  type?: string;
  envelope_id?: string;
  reason?: string;
  payload?: {
    type?: string;
    event?: unknown;
    event_id?: string;
  } & Record<string, unknown>;
}

export interface SocketModeHandlers {
  /** An Events API envelope (already acked). */
  onEvent: (input: { event: unknown; eventId: string }) => void;
  /** An interactivity envelope (already acked) — block actions etc. */
  onInteractive: (payload: Record<string, unknown>) => void;
  /** The connection can never come back on its own (bad app token, socket
   * mode disabled). The owner decides what happens next. */
  onPermanentFailure: (reason: string) => void;
  onLog?: (message: string, detail?: unknown) => void;
}

export interface SocketModeConnection {
  close: () => void;
  isOpen: () => boolean;
}

type SocketFactory = (url: string) => WebSocket;

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

export const openSocketMode = (
  options: {
    appToken: string;
    socketFactory?: SocketFactory;
  },
  handlers: SocketModeHandlers,
): SocketModeConnection => {
  const makeSocket: SocketFactory =
    options.socketFactory ?? ((url) => new WebSocket(url));

  let generation = 0;
  let socket: WebSocket | null = null;
  let open = false;
  let closed = false;
  let backoff = INITIAL_BACKOFF_MS;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const log = (message: string, detail?: unknown) =>
    handlers.onLog?.(message, detail);

  const scheduleReconnect = (why: string): void => {
    if (closed || retryTimer) return;
    log(`reconnecting in ${backoff}ms`, { why });
    // NOT unref'd on purpose: while the link is down this timer may be the
    // only thing keeping a quiet process alive (the ws.ts lesson — an
    // unref'd reconnect let the whole daemon exit mid-outage).
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void dial();
    }, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  };

  const dial = async (): Promise<void> => {
    if (closed) return;
    let url: string;
    try {
      url = (await connectionsOpen(options.appToken)).url;
    } catch (err) {
      if (err instanceof SlackApiError) {
        // Slack ANSWERED and said no — retrying the same token forever would
        // hide a misconfiguration (the runner's register law).
        closed = true;
        handlers.onPermanentFailure(err.code);
        return;
      }
      scheduleReconnect("connections.open transport failure");
      return;
    }
    if (closed) return;

    generation += 1;
    const mine = generation;
    const isCurrent = () => mine === generation && !closed;

    const ws = makeSocket(url);
    socket = ws;

    ws.addEventListener("open", () => {
      if (!isCurrent()) return;
      open = true;
      backoff = INITIAL_BACKOFF_MS;
      log("socket open");
    });

    ws.addEventListener("message", (event) => {
      if (!isCurrent()) return;
      let envelope: Envelope;
      try {
        envelope = JSON.parse(String(event.data)) as Envelope;
      } catch {
        return;
      }

      // Ack FIRST — everything after is our problem, not Slack's.
      if (envelope.envelope_id) {
        try {
          ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        } catch {
          // A failed ack means redelivery; the control-plane dedupe absorbs it.
        }
      }

      if (envelope.type === "hello") return;
      if (envelope.type === "disconnect") {
        // Slack refreshes links ~hourly; `warning` arrives ~10s early. Either
        // way: dial a fresh link and let this one die.
        log("disconnect frame", { reason: envelope.reason });
        if (envelope.reason === "link_disabled") {
          closed = true;
          handlers.onPermanentFailure("link_disabled");
          try {
            ws.close();
          } catch {
            /* already dying */
          }
          return;
        }
        generation += 1; // stale-guard: this socket no longer speaks for us
        try {
          ws.close();
        } catch {
          /* already dying */
        }
        void dial();
        return;
      }

      if (envelope.type === "events_api") {
        const eventId = envelope.payload?.event_id;
        const event = envelope.payload?.event;
        if (typeof eventId === "string" && event !== undefined) {
          handlers.onEvent({ event, eventId });
        }
        return;
      }

      if (envelope.type === "interactive" && envelope.payload) {
        handlers.onInteractive(envelope.payload);
      }
    });

    ws.addEventListener("error", () => {
      if (!isCurrent()) return;
      open = false;
      generation += 1;
      scheduleReconnect("socket error");
    });

    ws.addEventListener("close", () => {
      if (!isCurrent()) return;
      open = false;
      generation += 1;
      scheduleReconnect("socket close");
    });
  };

  void dial();

  return {
    close: () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      generation += 1;
      try {
        socket?.close();
      } catch {
        /* already dying */
      }
    },
    isOpen: () => open && !closed,
  };
};
