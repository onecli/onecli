/**
 * A scriptable stand-in for the global WebSocket — the
 * `apps/sandbox-supervisor/src/transport/ws.test.ts` pattern, as a class so
 * it can also be `vi.stubGlobal`'d where the code under test builds its own
 * sockets (the adapter's `openSocketMode` call passes no factory on purpose).
 * `openSocketMode` only ever uses addEventListener / send / close, so that is
 * all this implements.
 */
export class FakeSocket extends EventTarget {
  readonly url: string;
  /** 0 CONNECTING → 1 OPEN → 3 CLOSED (numeric literals; the real statics
   * are not available once the global is stubbed). */
  readyState = 0;
  /** Every frame the code under test sent — acks, in practice. */
  readonly sent: string[] = [];
  /** True once the code under test called close() on this socket. */
  closedByClient = false;
  /** Order-recording hook, fired synchronously inside send(). */
  onSend?: (data: string) => void;

  constructor(url: string) {
    super();
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
    this.onSend?.(data);
  }

  /** The code under test hanging up. Like the real WebSocket this only
   * STARTS the closing handshake — the close event arrives later (via
   * fail()), which is exactly the window the stale-socket guards exist for. */
  close(): void {
    this.closedByClient = true;
    this.readyState = 3;
  }

  // ── Test-side controls ────────────────────────────────────────────────────

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  emit(raw: string): void {
    this.dispatchEvent(new MessageEvent("message", { data: raw }));
  }

  /** The link dying on its own: close without closedByClient. */
  fail(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  /** A socket that never establishes may emit error and no close at all. */
  errorOnly(): void {
    this.dispatchEvent(new Event("error"));
  }
}
