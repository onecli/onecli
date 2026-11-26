// @vitest-environment jsdom
import { constants, deflateSync, inflateSync } from "node:zlib";
import type RFB from "@novnc/novnc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This is protocol regression evidence, not browser/guest acceptance. Only the
// transport and unavailable canvas APIs are fake: RFB is the installed package.
const CAPS = 0x01000000;
const REQUEST = 0x02000000;
const NOTIFY = 0x08000000;
const PROVIDE = 0x10000000;
const TEXT = 1;
const word = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
};
const cutText = (body: Uint8Array, extended = true): Buffer =>
  Buffer.concat([
    Buffer.from([3, 0, 0, 0]),
    word(extended ? -body.length : body.length),
    body,
  ]);
const action = (flags: number, body: Uint8Array = Buffer.alloc(0)): Buffer =>
  cutText(Buffer.concat([word(flags), body]));
const provide = (text: string): Buffer => {
  const encoded = Buffer.from(`${text}\0`, "utf8");
  return action(
    PROVIDE | TEXT,
    deflateSync(Buffer.concat([word(encoded.length), encoded])),
  );
};

class ProtocolSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static latest: ProtocolSocket | undefined;
  binaryType = "arraybuffer";
  protocol = "";
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;
  sent: Buffer[] = [];
  constructor() {
    ProtocolSocket.latest = this;
  }
  send(data: Uint8Array): void {
    this.sent.push(Buffer.from(data));
  }
  close(): void {
    this.readyState = 3;
    queueMicrotask(() =>
      this.onclose?.(new CloseEvent("close", { wasClean: true })),
    );
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  receive(data: Uint8Array): void {
    const copy = new Uint8Array(data.length);
    copy.set(data);
    this.onmessage?.(new MessageEvent("message", { data: copy.buffer }));
  }
  take(): Buffer {
    const result = Buffer.concat(this.sent);
    this.sent = [];
    return result;
  }
}

let client: RFB | undefined;
const connect = async (extended = true, clipboardMaxBytes = 1024) => {
  const { default: InstalledRFB } = await import("@novnc/novnc");
  const target = document.createElement("div");
  document.body.append(target);
  const rfb = new InstalledRFB(target, "ws://localhost/protocol-test", {
    clipboardAutoRequest: false,
    clipboardMaxBytes,
  });
  client = rfb;
  rfb.addEventListener("disconnect", () => {
    if (client === rfb) client = undefined;
  });
  const socket = ProtocolSocket.latest;
  if (!socket) throw new Error("RFB did not create a WebSocket");
  const connected = vi.fn();
  rfb.addEventListener("connect", connected);
  socket.open();
  socket.receive(Buffer.from("RFB 003.008\n"));
  expect(socket.take().toString()).toBe("RFB 003.008\n");
  socket.receive(Buffer.from([1, 1])); // one security type: None
  expect(socket.take()).toEqual(Buffer.from([1]));
  socket.receive(word(0)); // SecurityResult success
  expect(socket.take()).toEqual(Buffer.from([1])); // shared ClientInit
  socket.receive(
    Buffer.concat([
      Buffer.from([
        0, 1, 0, 1, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0,
      ]),
      word(4),
      Buffer.from("test"),
    ]),
  );
  expect(connected).toHaveBeenCalledOnce();
  socket.take(); // pixel format, encodings, initial framebuffer request
  if (extended) {
    socket.receive(action(CAPS | REQUEST | NOTIFY | PROVIDE | TEXT, word(0)));
    expect(socket.take()[0]).toBe(6); // client capability reply
  }
  return { rfb, socket };
};

const originalGetContext = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "getContext",
);

beforeEach(() => {
  ProtocolSocket.latest = undefined;
  vi.stubGlobal("WebSocket", ProtocolSocket);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal(
    "ImageData",
    class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    },
  );
  // Deliberately no RFB internals or rendering implementation in these stubs.
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => ({
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      putImageData: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(4),
        width: 1,
        height: 1,
      })),
    })),
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,",
  );
});
afterEach(async () => {
  client?.disconnect();
  await Promise.resolve();
  client = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  if (originalGetContext) {
    Object.defineProperty(
      HTMLCanvasElement.prototype,
      "getContext",
      originalGetContext,
    );
  }
  vi.unstubAllGlobals();
});

describe("installed noVNC explicit clipboard protocol", () => {
  it.each([
    "ordinary ASCII",
    "Καλημέρα 🌍\n日本語",
    "\uFEFFleading BOM",
    "middle\uFEFFBOM",
  ])("roundtrips %s only after explicit requests", async (text) => {
    const { rfb, socket } = await connect();
    let completed = false;
    const paste = rfb.clipboardPaste(text).then(() => {
      completed = true;
    });
    expect(socket.take()).toEqual(
      Buffer.concat([Buffer.from([6, 0, 0, 0]), word(-4), word(NOTIFY | TEXT)]),
    );
    await Promise.resolve();
    expect(completed).toBe(false);
    socket.receive(action(REQUEST | TEXT));
    await paste;
    expect(completed).toBe(true);
    const transmitted = socket.take();
    expect(transmitted[0]).toBe(6);
    expect(transmitted.readInt32BE(4)).toBe(-(transmitted.length - 8));
    expect(transmitted.readUInt32BE(8)).toBe(PROVIDE | TEXT);
    const inflated = inflateSync(transmitted.subarray(12), {
      finishFlush: constants.Z_SYNC_FLUSH,
    });
    const expectedText = Buffer.from(`${text.replace(/\n/g, "\r\n")}\0`);
    expect(inflated).toEqual(
      Buffer.concat([word(expectedText.length), expectedText]),
    );
    const read = rfb.clipboardRead();
    expect(socket.take()).toHaveLength(0);
    socket.receive(action(NOTIFY | TEXT));
    expect(socket.take()).toEqual(
      Buffer.concat([
        Buffer.from([6, 0, 0, 0]),
        word(-4),
        word(REQUEST | TEXT),
      ]),
    );
    socket.receive(provide(text.replace(/\n/g, "\r\n")));
    await expect(read).resolves.toBe(text);
  });

  it("writes a complete PROVIDE before Ctrl+V sent by the paste completion callback", async () => {
    const { rfb, socket } = await connect();
    const paste = rfb.clipboardPaste("ordered clipboard").then(() => {
      rfb.sendKey(0xffe3, "ControlLeft", true);
      rfb.sendKey(0x76, "KeyV", true);
      rfb.sendKey(0x76, "KeyV", false);
      rfb.sendKey(0xffe3, "ControlLeft", false);
    });
    await Promise.resolve();
    expect(socket.take()).toEqual(
      Buffer.concat([Buffer.from([6, 0, 0, 0]), word(-4), word(NOTIFY | TEXT)]),
    ); // No key messages before the server requests the announced text.
    socket.receive(action(REQUEST | TEXT));
    await paste;
    const wire = socket.take();
    expect(wire[0]).toBe(6);
    const provideLength = -wire.readInt32BE(4);
    expect(provideLength).toBeGreaterThan(4);
    expect(wire.readUInt32BE(8)).toBe(PROVIDE | TEXT);
    const firstKeyOffset = 8 + provideLength;
    const decoded = inflateSync(wire.subarray(12, firstKeyOffset), {
      finishFlush: constants.Z_SYNC_FLUSH,
    });
    const expectedText = Buffer.from("ordered clipboard\0");
    expect(decoded).toEqual(
      Buffer.concat([word(expectedText.length), expectedText]),
    );
    expect(wire.subarray(firstKeyOffset)).toEqual(
      Buffer.from([
        4, 1, 0, 0, 0, 0, 0xff, 0xe3, 4, 1, 0, 0, 0, 0, 0, 0x76, 4, 0, 0, 0, 0,
        0, 0, 0x76, 4, 0, 0, 0, 0, 0, 0xff, 0xe3,
      ]),
    );
  });

  it("announces changes without automatic synchronization and waits for a fresh NOTIFY", async () => {
    const { rfb, socket } = await connect();
    const changed = vi.fn();
    const clipboard = vi.fn();
    rfb.addEventListener("clipboardchange", changed);
    rfb.addEventListener("clipboard", clipboard);
    socket.receive(action(NOTIFY | TEXT));
    expect(changed).toHaveBeenCalledOnce();
    expect(socket.take()).toHaveLength(0);
    socket.receive(provide("unsolicited"));
    expect(clipboard).not.toHaveBeenCalled();
    const read = rfb.clipboardRead();
    expect(socket.take()).toHaveLength(0);
    socket.receive(action(NOTIFY));
    expect(socket.take()).toHaveLength(0);
    expect(changed).toHaveBeenCalledTimes(1);
    socket.receive(provide("stale"));
    expect(clipboard).not.toHaveBeenCalled();
    socket.receive(action(NOTIFY | TEXT));
    expect(changed).toHaveBeenCalledTimes(2);
    expect(socket.take().readUInt32BE(8)).toBe(REQUEST | TEXT);
    socket.receive(provide("fresh"));
    await expect(read).resolves.toBe("fresh");
  });

  it("uses legacy ClientCutText for ASCII and rejects unrepresentable Unicode", async () => {
    const { rfb, socket } = await connect(false);
    await expect(rfb.clipboardPaste("hello")).resolves.toBeUndefined();
    expect(socket.take()).toEqual(
      Buffer.concat([Buffer.from([6, 0, 0, 0]), word(5), Buffer.from("hello")]),
    );
    await expect(rfb.clipboardPaste("🌍")).rejects.toThrow();
    await expect(rfb.clipboardRead()).rejects.toThrow();
    expect(socket.take()).toHaveLength(0);
  });

  it.each(["clear", "disconnect", "viewOnly"])(
    "cancels pending reads and pastes on %s",
    async (reason) => {
      for (const operation of ["read", "requestedRead", "paste"]) {
        const { rfb, socket } = await connect();
        const pending =
          operation === "paste"
            ? rfb.clipboardPaste("private")
            : rfb.clipboardRead();
        const rejected = expect(pending).rejects.toThrow();
        if (operation !== "paste") expect(socket.take()).toHaveLength(0);
        if (operation === "requestedRead") {
          socket.receive(action(NOTIFY | TEXT));
          expect(socket.take().readUInt32BE(8)).toBe(REQUEST | TEXT);
        }
        socket.take();
        if (reason === "clear") rfb.clearClipboard();
        if (reason === "disconnect") socket.close();
        if (reason === "viewOnly") rfb.viewOnly = true;
        await rejected;
        socket.receive(action(REQUEST | TEXT));
        expect(socket.take()).toHaveLength(0);
        if (reason === "viewOnly") {
          await expect(rfb.clipboardPaste("blocked")).rejects.toThrow();
          await expect(rfb.clipboardRead()).rejects.toThrow();
        }
        if (socket.readyState !== ProtocolSocket.CLOSED) rfb.disconnect();
        await Promise.resolve();
      }
    },
  );

  it("permits only one pending operation and can read again after clearing", async () => {
    const { rfb, socket } = await connect();
    const pending = rfb.clipboardPaste("first");
    const cancelled = expect(pending).rejects.toThrow();
    await expect(rfb.clipboardPaste("second")).rejects.toThrow();
    await expect(rfb.clipboardRead()).rejects.toThrow();
    rfb.clearClipboard();
    await cancelled;
    socket.take(); // Discard the first paste's announcement.
    const read = rfb.clipboardRead();
    expect(socket.take()).toHaveLength(0);
    await expect(rfb.clipboardRead()).rejects.toThrow();
    await expect(rfb.clipboardPaste("third")).rejects.toThrow();
    socket.receive(action(NOTIFY | TEXT));
    expect(socket.take().readUInt32BE(8)).toBe(REQUEST | TEXT);
    socket.receive(provide("new"));
    await expect(read).resolves.toBe("new");
  });

  it.each([2147483647, -2147483648, 1025, -1025, -1, -3])(
    "rejects wire length %i before waiting for payload",
    async (length) => {
      const { rfb, socket } = await connect();
      const disconnected = vi.fn();
      rfb.addEventListener("disconnect", disconnected);
      socket.receive(Buffer.concat([Buffer.from([3, 0, 0, 0]), word(length)]));
      expect(socket.readyState).toBe(3);
      expect(disconnected).toHaveBeenCalledOnce();
    },
  );

  it.each([
    action(CAPS | TEXT),
    action(CAPS | TEXT, Buffer.concat([word(0), word(0)])),
    action(NOTIFY | TEXT, word(0)),
    action(REQUEST | TEXT, word(0)),
  ])("rejects malformed capability/action payload %#", async (frame) => {
    const { socket } = await connect();
    socket.receive(frame);
    expect(socket.readyState).toBe(3);
  });

  it.each([
    deflateSync(word(0xffffffff)),
    deflateSync(Buffer.concat([word(1021), Buffer.alloc(1021)])),
    Buffer.from([0, 1, 2, 3]),
    deflateSync(Buffer.concat([word(20), Buffer.from("short")])),
    deflateSync(Buffer.concat([word(2), Buffer.from([0xff, 0])])),
  ])(
    "rejects oversized expanded lengths or malformed data %#",
    async (compressed) => {
      const { rfb, socket } = await connect();
      const pending = rfb.clipboardRead();
      const rejected = expect(pending).rejects.toThrow();
      expect(socket.take()).toHaveLength(0);
      socket.receive(action(NOTIFY | TEXT));
      expect(socket.take().readUInt32BE(8)).toBe(REQUEST | TEXT);
      socket.receive(action(PROVIDE | TEXT, compressed));
      await rejected;
      expect(socket.readyState).toBe(3);
    },
  );

  it("consumes ignored frames without desynchronizing the next message", async () => {
    const { rfb, socket } = await connect();
    const bell = vi.fn();
    rfb.addEventListener("bell", bell);
    socket.receive(Buffer.concat([provide("ignored"), Buffer.from([2])]));
    expect(bell).toHaveBeenCalledOnce();
    rfb.viewOnly = true;
    socket.receive(
      Buffer.concat([
        provide("view only"),
        cutText(Buffer.from("legacy"), false),
        Buffer.from([2]),
      ]),
    );
    expect(bell).toHaveBeenCalledTimes(2);
    expect(socket.readyState).toBe(1);
    expect(socket.take()).toHaveLength(0);
  });

  it("waits for a complete fragmented PROVIDE and accepts the expanded byte boundary", async () => {
    const { rfb, socket } = await connect();
    const text = "a".repeat(1019); // 4-byte length + text + NUL = 1024
    let completed = false;
    const read = rfb.clipboardRead().then((value) => {
      completed = true;
      return value;
    });
    expect(socket.take()).toHaveLength(0);
    socket.receive(action(NOTIFY | TEXT));
    expect(socket.take().readUInt32BE(8)).toBe(REQUEST | TEXT);
    const frame = provide(text);
    socket.receive(frame.subarray(0, 5));
    await Promise.resolve();
    expect(completed).toBe(false);
    socket.receive(frame.subarray(5, frame.length - 1));
    await Promise.resolve();
    expect(completed).toBe(false);
    socket.receive(frame.subarray(frame.length - 1));
    await expect(read).resolves.toBe(text);
  });

  it.each(["a".repeat(1024), "🌍".repeat(256), "\n".repeat(512)])(
    "rejects oversized outgoing UTF-8 or newline expansion %# without announcing it",
    async (text) => {
      const { rfb, socket } = await connect();
      await expect(rfb.clipboardPaste(text)).rejects.toThrow();
      expect(socket.take()).toHaveLength(0);
    },
  );

  it("releases held keys through the public API", async () => {
    const { rfb, socket } = await connect();
    const canvas = document.querySelector("canvas");
    if (!canvas) throw new Error("RFB did not mount its input canvas");
    canvas.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Control",
        code: "ControlLeft",
        ctrlKey: true,
        bubbles: true,
      }),
    );
    expect(socket.take()).toEqual(Buffer.from([4, 1, 0, 0, 0, 0, 0xff, 0xe3]));
    rfb.releaseKeys();
    expect(socket.take()).toEqual(Buffer.from([4, 0, 0, 0, 0, 0, 0xff, 0xe3]));
  });
});
