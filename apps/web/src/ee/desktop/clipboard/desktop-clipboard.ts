import type RFB from "@novnc/novnc";
import { DESKTOP_CLIPBOARD_MAX_BYTES } from "@onecli/agent-protocol";

const MESSAGES = {
  unavailable: "Connect to the screen and take control to use the clipboard.",
  busy: "A clipboard transfer is already in progress.",
  empty: "There is no text to paste.",
  oversized: "Clipboard text must be 64 KiB or smaller.",
  invalid:
    "This clipboard contains unsupported control characters or invalid text.",
  noCopy: "No new text was copied.",
  copyDenied:
    "Copy was blocked by your browser. Allow clipboard access and try again.",
  timeout: "The clipboard did not respond. Reconnect and try again.",
  cancelled: "The clipboard transfer was cancelled.",
  transfer: "Clipboard transfer failed. Reconnect and try again.",
} as const;

type ClipboardErrorCode = keyof typeof MESSAGES;

/** Messages are fixed strings. Never surface browser/server errors or content. */
export class DesktopClipboardError extends Error {
  constructor(readonly code: ClipboardErrorCode) {
    super(MESSAGES[code]);
    this.name = "DesktopClipboardError";
  }
}

export const clipboardErrorMessage = (error: unknown): string =>
  error instanceof DesktopClipboardError ? error.message : MESSAGES.transfer;

/** Bound before encoding, reject rather than silently changing secret text. */
export const validateClipboardText = (text: string): void => {
  if (
    text.length > DESKTOP_CLIPBOARD_MAX_BYTES ||
    new TextEncoder().encode(text).byteLength > DESKTOP_CLIPBOARD_MAX_BYTES
  ) {
    throw new DesktopClipboardError("oversized");
  }
  for (const character of text) {
    const code = character.codePointAt(0) ?? -1;
    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 127 ||
      (code >= 0xd800 && code <= 0xdfff)
    ) {
      throw new DesktopClipboardError("invalid");
    }
  }
};

const XK_CONTROL = 0xffe3;
const XK_SHIFT = 0xffe1;
const TRANSFER_TIMEOUT_MS = 10_000;

type ClipboardClient = Pick<
  RFB,
  | "clipboardPaste"
  | "clipboardRead"
  | "clearClipboard"
  | "releaseKeys"
  | "sendKey"
  | "focus"
  | "disconnect"
  | "addEventListener"
  | "removeEventListener"
>;

/** One instance per RFB connection. Only trusted shortcuts start transfers.
 * No automatic reads, fallback cache, persistence, or clipboard synchronization. */
export const createDesktopClipboard = (
  client: ClipboardClient,
  isActive: () => boolean,
) => {
  let disposed = false;
  let busy = false;
  let pasting = false;
  let copyArmed = false;
  let requestSent = false;
  let generation = 0;
  let cancel: (() => void) | undefined;

  const onClipboardChange = () => {
    // The patched RFB sends its REQUEST immediately after this notification
    // when clipboardRead() is pending. No notification means no REQUEST.
    if (busy && copyArmed) requestSent = true;
  };
  client.addEventListener("clipboardchange", onClipboardChange);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    generation += 1;
    cancel?.();
    client.clearClipboard();
    client.releaseKeys();
    client.removeEventListener("clipboardchange", onClipboardChange);
    // RFB replies have no request IDs. Never let an abandoned reply satisfy
    // another operation. A terminal interrupt with no NOTIFY needs no close.
    if (busy && requestSent) client.disconnect();
  };

  const run = (
    kind: "paste" | "copy",
    operation: (check: () => void, cancelled: Promise<never>) => Promise<void>,
  ): Promise<void> => {
    if (disposed || !isActive()) {
      return Promise.reject(new DesktopClipboardError("unavailable"));
    }
    if (busy) return Promise.reject(new DesktopClipboardError("busy"));
    busy = true;
    pasting = kind === "paste";
    requestSent = false;
    const current = ++generation;
    const check = () => {
      if (disposed || generation !== current || !isActive()) {
        throw new DesktopClipboardError("cancelled");
      }
    };
    let timer: ReturnType<typeof setTimeout>;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(new DesktopClipboardError("cancelled"));
      timer = setTimeout(() => {
        reject(
          new DesktopClipboardError(
            kind === "copy" && !requestSent ? "noCopy" : "timeout",
          ),
        );
      }, TRANSFER_TIMEOUT_MS);
    });
    let failed = false;
    // Invoke synchronously: Clipboard.write must begin inside the key gesture.
    return Promise.race([operation(check, cancelled), cancelled])
      .catch((error: unknown) => {
        failed = true;
        if (error instanceof DesktopClipboardError) throw error;
        throw new DesktopClipboardError("transfer");
      })
      .finally(() => {
        clearTimeout(timer);
        // Invalidate BEFORE rejecting RFB's read. Even a late promise resolution
        // after denial or timeout must not supply a Blob or affect a later run.
        generation += 1;
        cancel?.();
        if (failed && requestSent && !disposed) dispose();
        else if (!disposed) client.clearClipboard();
        cancel = undefined;
        busy = false;
        pasting = false;
        copyArmed = false;
        requestSent = false;
      });
  };

  const chord = (letter: "c" | "v", shift: boolean) => {
    client.releaseKeys();
    client.sendKey(XK_CONTROL, "ControlLeft", true);
    if (shift) client.sendKey(XK_SHIFT, "ShiftLeft", true);
    client.sendKey(letter.charCodeAt(0), letter === "c" ? "KeyC" : "KeyV");
    if (shift) client.sendKey(XK_SHIFT, "ShiftLeft", false);
    client.sendKey(XK_CONTROL, "ControlLeft", false);
  };

  const paste = (text: string, shift = false) =>
    run("paste", async (check, cancelled) => {
      check();
      if (!text) throw new DesktopClipboardError("empty");
      validateClipboardText(text);
      requestSent = true;
      await Promise.race([client.clipboardPaste(text), cancelled]);
      check();
      client.focus();
      chord("v", shift);
    });

  const copy = (shift = false) => {
    const result = run("copy", async (check, cancelled) => {
      const clipboard = navigator.clipboard;
      if (typeof ClipboardItem === "undefined" || !clipboard?.write) {
        throw new DesktopClipboardError("copyDenied");
      }
      copyArmed = true;
      const blob = Promise.race([client.clipboardRead(), cancelled]).then(
        (value) => {
          check();
          validateClipboardText(value);
          return new Blob([value], { type: "text/plain" });
        },
      );
      // A browser may reject without ever consuming the ClipboardItem promise.
      void blob.catch(() => undefined);
      let write: Promise<void>;
      try {
        write = clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      } catch {
        throw new DesktopClipboardError("copyDenied");
      }
      await Promise.all([
        blob,
        write.catch(() => {
          throw new DesktopClipboardError("copyDenied");
        }),
      ]);
      check();
    });
    // Ctrl+C is also a terminal interrupt, even when copy is unavailable/busy.
    if (!disposed && isActive()) chord("c", shift);
    return result;
  };

  return {
    paste,
    copy,
    dispose,
    get pasting() {
      return pasting;
    },
  };
};

export type DesktopClipboard = ReturnType<typeof createDesktopClipboard>;
