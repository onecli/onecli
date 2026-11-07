"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import type RFB from "@novnc/novnc";
import { DESKTOP_CLIPBOARD_MAX_WIRE_BYTES } from "@onecli/agent-protocol";
import { toast } from "sonner";
import {
  clipboardErrorMessage,
  createDesktopClipboard,
  DesktopClipboardError,
  type DesktopClipboard,
} from "./clipboard/desktop-clipboard";
import { cn } from "@onecli/ui/lib/utils";
import * as desktopApi from "./api";
import { DesktopPlaceholder } from "./desktop-placeholder";
import { KEYBOARD_SENTINEL, keystrokesFor } from "./keyboard-bridge";

/**
 * The subprotocol the relay speaks for a desktop stream and the shape of
 * the ticket offer beside it. Client and relay must agree.
 */
export const DESKTOP_SUBPROTOCOL = "onecli-desktop";

/** What the view is doing, for the bar and the overlay. `paused` is a
 * hidden tab: no stream, no retries, until the tab is visible again. */
export type DesktopViewStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "paused"
  | "closed";

export interface DesktopViewProps {
  /** The share to stream: the view host, or the control host while the
   * viewer holds the lease. A change reconnects. */
  host: string;
  /** Drop input before it is sent (the watcher's mode). Switched live. */
  viewOnly: boolean;
  /**
   * JPEG quality, noVNC's 0..9. The theater asks for {@link QUALITY_THEATER}
   * (text crisp at full size); the floating card, a fifth of the size and
   * glanced at, asks for {@link QUALITY_CARD} to reduce image bandwidth.
   * Switched live; no reconnect.
   */
  quality?: number;
  onStatus?: (status: DesktopViewStatus) => void;
  /** Esc with the canvas focused: the person wants out of the captured
   * screen (focus moves to the bar's Stop). Only fired while driving. */
  onEscape?: () => void;
  className?: string;
  ref?: Ref<DesktopViewHandle>;
}

export interface DesktopViewHandle {
  /** Put keyboard focus on the canvas (after Take control). */
  focus: () => void;
  /**
   * Raise a touch device's software keyboard and type through it (see
   * keyboard-bridge.ts). Must run inside the tap's own handler: iOS shows
   * the keyboard only for a focus made synchronously in a user gesture.
   * Inert while watching.
   */
  openKeyboard: () => void;
  cancelClipboard: () => void;
}

/**
 * Tuned for a person's eyes on a screen the agent is driving: JPEG quality
 * 7 of 9 keeps text crisp at a fraction of lossless bytes, and compression
 * 1 favors low encode latency for an interactive screen.
 */
export const QUALITY_THEATER = 7;
/** The card's quality: the frame is a few hundred pixels wide, so the
 * artefacts of 5 are below what the eye resolves there. */
export const QUALITY_CARD = 5;
const COMPRESSION_LEVEL = 1;
/** Reconnect backoff: fast first (a blip), then bounded. */
const RECONNECT_MS = [500, 1000, 2000, 4000, 8000] as const;

/**
 * Whether the page is on screen. A tab in the background keeps a quiet
 * stream open for nobody, and when the edge drops that idle socket the
 * reconnect mints a ticket and beats the relay, for hours. The stream is
 * for eyes: hidden means disconnected, visible means connected.
 */
const usePageVisible = () => {
  // `null` until the first read: the server's and the client's first
  // frame agree (no `document` during render), and nothing connects on a
  // guess. The read lands in this effect, which is declared before the
  // connect effect and so runs before it on mount.
  const [visible, setVisible] = useState<boolean | null>(null);
  useEffect(() => {
    const read = () => setVisible(!document.hidden);
    read();
    document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, []);
  return visible;
};

/**
 * The agent's screen, live: noVNC's `RFB` driving a canvas inside this
 * container, over a WebSocket to the screen's share host. One component, two modes
 * (`viewOnly`): the watcher and the controller see the same stream; only
 * whether keystrokes and clicks leave the page differs, and noVNC flips
 * that live without reconnecting.
 *
 * The credential is a one-minute ticket from the api, offered in the
 * WebSocket subprotocol (the browser's WebSocket API has no headers and
 * SameSite withholds cookies cross-site), minted fresh per connection.
 *
 * noVNC touches `document` at import and uses top-level await, so it is
 * imported inside the effect (never at module level): this file is safe to
 * import from a server-rendered tree, and the library lands in its own
 * chunk, fetched the first time a screen actually mounts.
 */
export const DesktopView = ({
  host,
  viewOnly,
  quality = QUALITY_THEATER,
  onStatus,
  onEscape,
  className,
  ref,
}: DesktopViewProps) => {
  const container = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const clipboard = useRef<DesktopClipboard | null>(null);
  const pasteShift = useRef(false);
  const capturedKeys = useRef(new Set<string>());
  const connectionStatus = useRef<DesktopViewStatus>("connecting");
  const pendingFocus = useRef(false);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const typed = useRef(KEYBOARD_SENTINEL);
  const composing = useRef(false);
  const [status, setStatus] = useState<DesktopViewStatus>("connecting");
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  const viewOnlyRef = useRef(viewOnly);
  viewOnlyRef.current = viewOnly;
  const qualityRef = useRef(quality);
  qualityRef.current = quality;
  const visible = usePageVisible();

  const report = useCallback((next: DesktopViewStatus) => {
    connectionStatus.current = next;
    setStatus(next);
    statusRef.current?.(next);
  }, []);

  const attachClipboard = useCallback((client: RFB) => {
    clipboard.current = createDesktopClipboard(
      client,
      () =>
        rfb.current === client &&
        connectionStatus.current === "connected" &&
        !viewOnlyRef.current &&
        !document.hidden,
    );
  }, []);

  const cancelClipboard = useCallback(() => {
    const current = clipboard.current;
    clipboard.current = null;
    current?.dispose();
    // A fresh connection prevents uncorrelated old replies being reused.
    rfb.current?.disconnect();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        if (rfb.current) rfb.current.focus();
        else pendingFocus.current = true;
      },
      openKeyboard: () => {
        if (viewOnlyRef.current) return;
        const field = keyboard.current;
        if (!field) return;
        field.value = KEYBOARD_SENTINEL;
        typed.current = KEYBOARD_SENTINEL;
        field.focus({ preventScroll: true });
        field.setSelectionRange(field.value.length, field.value.length);
      },
      cancelClipboard,
    }),
    [cancelClipboard],
  );

  /** The field changed: send the difference as key presses (see
   * keyboard-bridge.ts), then put the sentinel back at once. Nothing the
   * person typed (a password into the guest browser, a 2FA code) stays in
   * this page's DOM past the keystroke that sent it. */
  const typeFromField = (event?: React.FormEvent<HTMLTextAreaElement>) => {
    const field = keyboard.current;
    if (!field || composing.current) return;
    const client = rfb.current;
    const input = event?.nativeEvent;
    const pasted =
      input instanceof InputEvent &&
      (input.inputType === "insertFromPaste" ||
        input.inputType === "insertFromDrop");
    if (pasted) {
      // A mobile browser may report input without a paste event. Never turn
      // pasted newlines/tabs into Return/Tab keystrokes in that fallback path.
      toast.error(
        "Paste was blocked by this browser. Use Ctrl+V or ⌘V with the screen focused.",
      );
    } else if (client && !viewOnlyRef.current) {
      for (const keysym of keystrokesFor(typed.current, field.value)) {
        client.sendKey(keysym, null);
      }
    }
    if (field.value !== KEYBOARD_SENTINEL) {
      field.value = KEYBOARD_SENTINEL;
      field.setSelectionRange(field.value.length, field.value.length);
    }
    typed.current = KEYBOARD_SENTINEL;
  };

  // Connect, and reconnect with backoff while mounted and on screen. The
  // effect owns one generation: unmount, a host change, or the tab going
  // hidden tears it down (a hidden tab holds no stream and runs no retry
  // timer), and any late event from a torn-down client is ignored by the
  // `alive` check. The tab coming back runs a fresh generation.
  useEffect(() => {
    const target = container.current;
    if (!target) return;
    if (visible === null) return;
    if (!visible) {
      report("paused");
      return;
    }
    let alive = true;
    const keys = capturedKeys.current;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let client: RFB | null = null;

    const connect = async () => {
      if (!alive) return;
      report(attempt === 0 ? "connecting" : "reconnecting");
      let ticket: string;
      try {
        ({ ticket } = await desktopApi.ticket(host));
      } catch {
        scheduleRetry();
        return;
      }
      if (!alive) return;
      try {
        const { default: Rfb } = await import("@novnc/novnc");
        if (!alive) return;
        const next = new Rfb(target, `wss://${host}/`, {
          wsProtocols: [DESKTOP_SUBPROTOCOL, `t.${ticket}`],
          shared: true,
          clipboardAutoRequest: false,
          clipboardMaxBytes: DESKTOP_CLIPBOARD_MAX_WIRE_BYTES,
        });
        client = next;
        rfb.current = next;
        next.viewOnly = viewOnlyRef.current;
        next.scaleViewport = true;
        next.clipViewport = false;
        next.resizeSession = false;
        next.qualityLevel = qualityRef.current;
        next.compressionLevel = COMPRESSION_LEVEL;
        next.background = "transparent";
        next.addEventListener("connect", () => {
          if (!alive || client !== next) return;
          attempt = 0;
          report("connected");
          if (!viewOnlyRef.current) attachClipboard(next);
          if (pendingFocus.current) {
            pendingFocus.current = false;
            next.focus();
          }
        });
        next.addEventListener("disconnect", () => {
          if (!alive || client !== next) return;
          client = null;
          rfb.current = null;
          const previous = clipboard.current;
          clipboard.current = null;
          previous?.dispose();
          keys.clear();
          pasteShift.current = false;
          scheduleRetry();
        });
      } catch {
        const failed = client;
        client = null;
        rfb.current = null;
        failed?.disconnect();
        if (alive) {
          target.replaceChildren();
          scheduleRetry();
        }
      }
    };

    const scheduleRetry = () => {
      if (!alive) return;
      const delay = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)]!;
      attempt += 1;
      report("reconnecting");
      timer = setTimeout(() => void connect(), delay);
    };

    void connect();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      const current = client;
      client = null;
      rfb.current = null;
      const previous = clipboard.current;
      clipboard.current = null;
      previous?.dispose();
      keys.clear();
      pasteShift.current = false;
      current?.disconnect();
      report("closed");
    };
  }, [host, visible, report, attachClipboard]);

  // The mode flips live; noVNC needs no reconnect for it.
  useEffect(() => {
    const client = rfb.current;
    if (!client) return;
    if (viewOnly) {
      const previous = clipboard.current;
      clipboard.current = null;
      previous?.dispose();
    }
    client.viewOnly = viewOnly;
    if (
      !viewOnly &&
      !clipboard.current &&
      connectionStatus.current === "connected"
    ) {
      attachClipboard(client);
    }
  }, [viewOnly, attachClipboard]);
  // So does the quality (noVNC re-sends its encodings on the change).
  useEffect(() => {
    if (rfb.current) rfb.current.qualityLevel = quality;
  }, [quality]);

  // Esc is the universal "let me out" of a captured screen. noVNC consumes
  // every key on its canvas, so the listener sits on the container in the
  // capture phase, and only while driving: a watcher's Esc is just a key.
  const onKeyDownCapture = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" && !viewOnly && escapeRef.current) {
      event.preventDefault();
      event.stopPropagation();
      if (clipboard.current?.pasting) cancelClipboard();
      rfb.current?.releaseKeys();
      escapeRef.current();
      return;
    }
    if (viewOnlyRef.current) return;
    if (
      clipboard.current?.pasting &&
      !["Control", "Meta", "Shift", "Alt"].includes(event.key)
    ) {
      // No shortcut or target-changing key may race an unfinished paste.
      event.preventDefault();
      event.stopPropagation();
      cancelClipboard();
      return;
    }
    if (!event.isTrusted || event.altKey) return;
    const key = event.key.toLowerCase();
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const modifier = mac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (modifier && (key === "c" || key === "v")) {
      event.stopPropagation();
      capturedKeys.current.add(event.code);
      rfb.current?.releaseKeys();
      if (key === "v") {
        // Let the browser dispatch a genuine paste event. Its plain-text data
        // needs no background clipboard-read permission. Do not send V twice.
        pasteShift.current = event.shiftKey;
      } else {
        event.preventDefault();
        const operation = clipboard.current?.copy(event.shiftKey);
        void operation?.catch((error: unknown) => {
          // Ctrl+C can be a terminal interrupt, not a copy. Keep it quiet.
          if (
            error instanceof DesktopClipboardError &&
            (error.code === "noCopy" || error.code === "cancelled")
          )
            return;
          toast.error(clipboardErrorMessage(error));
        });
      }
    }
  };

  const onPasteCapture = (event: React.ClipboardEvent) => {
    if (viewOnlyRef.current || !clipboard.current) return;
    event.preventDefault();
    event.stopPropagation();
    const shift = pasteShift.current;
    pasteShift.current = false;
    const text = event.clipboardData.getData("text/plain");
    void clipboard.current.paste(text, shift).catch((error: unknown) => {
      if (error instanceof DesktopClipboardError && error.code === "cancelled")
        return;
      toast.error(clipboardErrorMessage(error));
    });
  };

  return (
    <div
      className={cn("ph-no-capture relative min-h-0 min-w-0 flex-1", className)}
      onKeyDownCapture={onKeyDownCapture}
      onKeyUpCapture={(event) => {
        if (capturedKeys.current.delete(event.code)) {
          event.stopPropagation();
          pasteShift.current = false;
        }
      }}
      onPasteCapture={onPasteCapture}
      onPointerDownCapture={(event) => {
        if (!clipboard.current?.pasting) return;
        event.preventDefault();
        event.stopPropagation();
        cancelClipboard();
      }}
      onBlurCapture={(event) => {
        if (
          clipboard.current?.pasting &&
          (!(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget))
        )
          cancelClipboard();
      }}
    >
      {/* noVNC fills this element with its canvas; the focus ring is the
          one visible sign that keystrokes now go to the agent's screen. */}
      <div
        ref={container}
        className={cn(
          "ring-ring/0 size-full overflow-hidden rounded-lg transition-shadow has-[canvas:focus-visible]:ring-2",
          !viewOnly && "has-[canvas:focus-visible]:ring-ring",
        )}
        data-status={status}
        aria-label={
          viewOnly
            ? "The agent's screen"
            : "The agent's screen, under your control"
        }
        role="img"
      />
      {!viewOnly && (
        // The phone keyboard's field: off-screen to the eye, focused by the
        // pill's Keyboard button. Everything typed here goes to the screen.
        <textarea
          ref={keyboard}
          aria-label="Type on the agent's screen"
          className="ph-no-capture pointer-events-none absolute bottom-0 left-0 size-px resize-none opacity-0"
          defaultValue={KEYBOARD_SENTINEL}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          // Keep password managers off a field that only ever relays keys.
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          tabIndex={-1}
          onInput={typeFromField}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
            typeFromField();
          }}
        />
      )}
      {status !== "connected" && (
        <DesktopPlaceholder
          {...(status === "paused"
            ? {
                caption: "Paused",
                detail: "The screen comes back when this tab is in front.",
                busy: false,
              }
            : status === "closed"
              ? { caption: "Disconnected", busy: false }
              : {
                  caption:
                    status === "reconnecting" ? "Reconnecting…" : "Connecting…",
                  busy: true,
                })}
        />
      )}
    </div>
  );
};
