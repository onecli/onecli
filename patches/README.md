# noVNC clipboard patch

`@novnc/novnc` stays pinned to **1.7.0**. The package retains its upstream MPL-2.0 license. pnpm applies `@novnc__novnc@1.7.0.patch` during installation.

The Computer viewer needs explicit, bounded clipboard operations. Upstream's `clipboardPasteFrom()` only announces extended clipboard text, so sending Ctrl+V immediately afterward can paste the previous selection. Upstream also automatically requests remote text on clipboard notifications and does not bound declared decompressed clipboard sizes before inflation.

## Narrow public additions

- `clipboardAutoRequest: false` disables automatic remote clipboard requests. It does not read or write the operating system clipboard.
- `clipboardMaxBytes` bounds received wire frames and declared decompressed clipboard data before allocation. The application supplies the shared wire limit, leaving room for CRLF conversion and protocol overhead around its separate 64 KiB UTF-8 text limit.
- `clipboardPaste(text)` resolves after the text is actually sent, including the extended REQUEST/PROVIDE exchange. The application then sends a balanced guest paste shortcut on the same ordered stream. This is not an acknowledgement that the target application accepted the paste.
- `clipboardRead()` waits for the next remote clipboard notification caused by a copy shortcut, then explicitly requests its text. It never substitutes an old cached selection.
- `clearClipboard()` rejects pending operations and releases retained outgoing text.
- `releaseKeys()` releases noVNC's tracked keys before application-owned shortcuts.
- `clipboardchange` reports a remote availability notification without its contents, letting the adapter distinguish waiting for a copy from an in-flight read when cancelling.

Disconnect and view-only transitions cancel pending operations. Ignored clipboard frames are consumed completely to keep the RFB stream aligned. Extended text is decoded as strict UTF-8 without stripping a leading U+FEFF, bounded before inflation, and requires its protocol terminator. Legacy outgoing text rejects unrepresentable characters rather than corrupting a password.

## Privacy boundary

Transfers occur only for the user's copy or paste action while controlling the desktop. The adapter does not automatically read the local clipboard, synchronize remote changes, persist clipboard text, or log its contents. This does not make the guest a secret store: text deliberately pasted into it becomes guest clipboard and application data, which software inside that desktop may read. It does not retrieve or inject credentials from OneCLI's vault.

Cancellation and completion release application-owned references. They cannot securely erase JavaScript strings, revoke text already delivered to the guest, or clear the operating system's clipboard. Browser clipboard permission and support still apply. The shortcuts do not bypass either.

## Ownership and validation

The application adapter in `apps/web/src/ee/desktop/clipboard/desktop-clipboard.ts` owns permission prompts, explicit user gestures, text validation, timeouts, lifecycle cancellation, and the native clipboard. Those policies do not live in this dependency patch.

`novnc-clipboard.test.ts` exercises the installed patched package through its public constructor and methods, with RFB frames over a test WebSocket. Those regression tests do not replace live verification with the real dashboard and a real VNC desktop. On upgrades, rebase the patch deliberately, run those tests and the real desktop checks, and remove additions if equivalent upstream APIs become available. Never patch installed package files directly or reach into RFB private fields from application code.
