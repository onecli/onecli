import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_CLIPBOARD_MAX_BYTES } from "@onecli/agent-protocol";
import {
  clipboardErrorMessage,
  createDesktopClipboard,
  DesktopClipboardError,
  validateClipboardText,
} from "./desktop-clipboard";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

/** Synthetic browser/RFB seam. Live browser permission and guest behavior are
 * separate acceptance gates. Pending reads deliberately survive clearClipboard
 * here to prove cancellation also fences late, uncooperative resolutions. */
const setup = () => {
  type Client = Parameters<typeof createDesktopClipboard>[0];
  const blobs: Promise<Blob>[] = [];
  vi.stubGlobal(
    "ClipboardItem",
    class {
      constructor(data: Record<string, Promise<Blob>>) {
        const blob = data["text/plain"];
        if (!blob) throw new Error("Missing plain text");
        blobs.push(blob);
      }
    },
  );
  const local = {
    readText: vi.fn<() => Promise<string>>(),
    writeText: vi.fn<(text: string) => Promise<void>>(),
    write: vi
      .fn<(items: ClipboardItem[]) => Promise<void>>()
      .mockImplementation(async () => {
        await blobs.at(-1);
      }),
  };
  vi.stubGlobal("navigator", { clipboard: local });
  const client = {
    clipboardPaste: vi.fn<Client["clipboardPaste"]>().mockResolvedValue(),
    clipboardRead: vi
      .fn<Client["clipboardRead"]>()
      .mockResolvedValue("guest text"),
    clearClipboard: vi.fn<Client["clearClipboard"]>(),
    releaseKeys: vi.fn<Client["releaseKeys"]>(),
    sendKey: vi.fn<Client["sendKey"]>(),
    focus: vi.fn<Client["focus"]>(),
    disconnect: vi.fn<Client["disconnect"]>(),
    addEventListener: vi.fn<Client["addEventListener"]>(),
    removeEventListener: vi.fn<Client["removeEventListener"]>(),
  } satisfies Client;
  let active = true;
  const adapter = createDesktopClipboard(client, () => active);
  const notify = () => {
    for (const [name, listener] of client.addEventListener.mock.calls) {
      if (name === "clipboardchange")
        listener(new CustomEvent("clipboardchange", { detail: {} }));
    }
  };
  return {
    adapter,
    client,
    local,
    blobs,
    notify,
    setActive: (value: boolean) => {
      active = value;
    },
  };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("shortcut clipboard validation", () => {
  it.each([
    "ASCII",
    "العربية 中文 😀 e\u0301",
    "\t\r\n",
    "é".repeat(32_768),
    "😀".repeat(16_384),
    "a".repeat(DESKTOP_CLIPBOARD_MAX_BYTES),
  ])("accepts exact UTF-8 within the byte budget (%#)", (text) => {
    expect(() => validateClipboardText(text)).not.toThrow();
  });
  it.each([
    "a".repeat(DESKTOP_CLIPBOARD_MAX_BYTES + 1),
    "é".repeat(32_769),
    "😀".repeat(16_385),
  ])("rejects over-budget UTF-8 without truncation (%#)", (text) => {
    expect(() => validateClipboardText(text)).toThrow(
      new DesktopClipboardError("oversized"),
    );
  });
  it.each([
    ...Array.from({ length: 32 }, (_, code) => code).filter(
      (code) => ![9, 10, 13].includes(code),
    ),
    127,
    0xd800,
    0xdfff,
  ])("rejects unsupported code point %i", (code) => {
    expect(() =>
      validateClipboardText(`before${String.fromCharCode(code)}after`),
    ).toThrow(new DesktopClipboardError("invalid"));
  });
});

describe("paste shortcut", () => {
  it("uses supplied text only and waits for guest transfer before balanced Ctrl+Shift+V", async () => {
    const { adapter, client, local } = setup();
    const accepted = deferred<void>();
    client.clipboardPaste.mockReturnValue(accepted.promise);
    const text = " العربية\t中文 😀 e\u0301\r\n ";
    const operation = adapter.paste(text, true);
    expect(client.clipboardPaste).toHaveBeenCalledWith(text);
    expect(client.sendKey).not.toHaveBeenCalled();
    expect(adapter.pasting).toBe(true);
    accepted.resolve();
    await operation;
    expect(client.focus).toHaveBeenCalledOnce();
    expect(client.sendKey.mock.calls).toEqual([
      [0xffe3, "ControlLeft", true],
      [0xffe1, "ShiftLeft", true],
      [118, "KeyV"],
      [0xffe1, "ShiftLeft", false],
      [0xffe3, "ControlLeft", false],
    ]);
    expect(adapter.pasting).toBe(false);
    expect(local.readText).not.toHaveBeenCalled();
    expect(local.writeText).not.toHaveBeenCalled();
    expect(local.write).not.toHaveBeenCalled();
  });
  it.each(["", "bad\0text", "😀".repeat(16_385)])(
    "rejects invalid supplied text before guest activity (%#)",
    async (text) => {
      const { adapter, client } = setup();
      await expect(adapter.paste(text)).rejects.toBeInstanceOf(
        DesktopClipboardError,
      );
      expect(client.clipboardPaste).not.toHaveBeenCalled();
      expect(client.sendKey).not.toHaveBeenCalled();
      expect(client.disconnect).not.toHaveBeenCalled();
    },
  );
  it.each(["dispose", "lost control"])(
    "prevents late paste chord after %s",
    async (reason) => {
      const { adapter, client, setActive } = setup();
      const accepted = deferred<void>();
      client.clipboardPaste.mockReturnValue(accepted.promise);
      const operation = adapter.paste("pending");
      const rejection = expect(operation).rejects.toMatchObject({
        code: "cancelled",
      });
      if (reason === "dispose") adapter.dispose();
      else setActive(false);
      accepted.resolve();
      await rejection;
      expect(client.sendKey).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalledOnce();
    },
  );
});

describe("fresh copy shortcut", () => {
  it("preserves a leading BOM as bytes rather than treating it as transport metadata", async () => {
    const { adapter, client, blobs } = setup();
    const text = "\ufeffleading BOM";
    client.clipboardRead.mockResolvedValue(text);
    await adapter.copy();
    const blob = await blobs[0];
    expect(blob).toBeDefined();
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(
      new TextEncoder().encode(text),
    );
  });

  it("arms a fresh read and synchronous promise-backed native write before sending Ctrl+Shift+C", async () => {
    const { adapter, client, local, blobs } = setup();
    const read = deferred<string>();
    client.clipboardRead.mockReturnValue(read.promise);
    const operation = adapter.copy(true);
    expect(client.clipboardRead).toHaveBeenCalledWith();
    expect(local.write).toHaveBeenCalledOnce();
    expect(client.clipboardRead.mock.invocationCallOrder[0]).toBeLessThan(
      local.write.mock.invocationCallOrder[0]!,
    );
    expect(local.write.mock.invocationCallOrder[0]).toBeLessThan(
      client.sendKey.mock.invocationCallOrder[0]!,
    );
    expect(client.sendKey.mock.calls).toEqual([
      [0xffe3, "ControlLeft", true],
      [0xffe1, "ShiftLeft", true],
      [99, "KeyC"],
      [0xffe1, "ShiftLeft", false],
      [0xffe3, "ControlLeft", false],
    ]);
    const text = "العربية 中文 😀 e\u0301\r\n";
    read.resolve(text);
    await operation;
    expect(await (await blobs[0])?.text()).toBe(text);
    expect(local.writeText).not.toHaveBeenCalled();
    expect(local.readText).not.toHaveBeenCalled();
  });
  it("never writes automatically and never reuses text on subsequent shortcuts", async () => {
    const { adapter, client, local, blobs, notify } = setup();
    notify();
    expect(local.write).not.toHaveBeenCalled();
    client.clipboardRead
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");
    await adapter.copy();
    notify();
    expect(local.write).toHaveBeenCalledOnce();
    await adapter.copy();
    expect(client.clipboardRead.mock.calls).toEqual([[], []]);
    expect(await (await blobs[0])?.text()).toBe("first");
    expect(await (await blobs[1])?.text()).toBe("second");
    expect(local.writeText).not.toHaveBeenCalled();
  });
  it.each(["ClipboardItem", "write"])(
    "refuses unsupported %s with a fixed error but forwards the terminal interrupt",
    async (missing) => {
      const { adapter, client, local } = setup();
      if (missing === "ClipboardItem")
        vi.stubGlobal("ClipboardItem", undefined);
      else vi.stubGlobal("navigator", { clipboard: {} });
      await expect(adapter.copy()).rejects.toEqual(
        new DesktopClipboardError("copyDenied"),
      );
      expect(client.sendKey).toHaveBeenCalledWith(99, "KeyC");
      expect(client.clipboardRead).not.toHaveBeenCalled();
      expect(local.writeText).not.toHaveBeenCalled();
      expect(client.disconnect).not.toHaveBeenCalled();
    },
  );
  it("inactive and disposed connections do not read, write, or send shortcut keys", async () => {
    const { adapter, client, local, setActive } = setup();
    setActive(false);
    await expect(adapter.copy()).rejects.toMatchObject({ code: "unavailable" });
    await expect(adapter.paste("text")).rejects.toMatchObject({
      code: "unavailable",
    });
    setActive(true);
    adapter.dispose();
    await expect(adapter.copy()).rejects.toMatchObject({ code: "unavailable" });
    expect(client.clipboardRead).not.toHaveBeenCalled();
    expect(local.write).not.toHaveBeenCalled();
    expect(client.sendKey).not.toHaveBeenCalled();
  });
  it("forwards terminal Ctrl+C while busy but does not start another native write or read", async () => {
    const { adapter, client, local } = setup();
    const read = deferred<string>();
    client.clipboardRead.mockReturnValue(read.promise);
    const operation = adapter.copy();
    await expect(adapter.copy()).rejects.toMatchObject({ code: "busy" });
    expect(client.clipboardRead).toHaveBeenCalledOnce();
    expect(local.write).toHaveBeenCalledOnce();
    expect(
      client.sendKey.mock.calls.filter((call) => call[0] === 99),
    ).toHaveLength(2);
    read.resolve("text");
    await operation;
  });
  it.each(["bad\0text", "😀".repeat(16_385)])(
    "rejects invalid guest text before Blob resolution (%#)",
    async (text) => {
      const { adapter, client, blobs } = setup();
      client.clipboardRead.mockResolvedValue(text);
      const operation = adapter.copy();
      await expect(operation).rejects.toBeInstanceOf(DesktopClipboardError);
      await expect(blobs[0]).rejects.toBeInstanceOf(DesktopClipboardError);
    },
  );
});

describe("cancellation and early native denial", () => {
  it("handles a rejecting ClipboardItem constructor without an orphaned read or timer", async () => {
    const { adapter, client, local } = setup();
    const read = deferred<string>();
    client.clipboardRead.mockReturnValue(read.promise);
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor() {
          throw new Error("private constructor failure");
        }
      },
    );
    await expect(adapter.copy()).rejects.toEqual(
      new DesktopClipboardError("copyDenied"),
    );
    expect(client.clearClipboard).toHaveBeenCalledOnce();
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(local.write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    read.reject(new Error("late rejected RFB read"));
    await Promise.resolve();
    await Promise.resolve();
  });

  it("rejects the pending Blob and consumes a late read rejection after native denial", async () => {
    const { adapter, client, local, blobs } = setup();
    const read = deferred<string>();
    client.clipboardRead.mockReturnValue(read.promise);
    local.write.mockRejectedValue(new Error("private denial"));
    await expect(adapter.copy()).rejects.toEqual(
      new DesktopClipboardError("copyDenied"),
    );
    await expect(blobs[0]).rejects.toMatchObject({ code: "cancelled" });
    expect(vi.getTimerCount()).toBe(0);
    read.reject(new Error("late rejected RFB read"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(local.write).toHaveBeenCalledOnce();
    expect(local.writeText).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it.each(["synchronous", "asynchronous"])(
    "cancels immediately on %s denial, fences late NOTIFY/text, and permits a fresh operation",
    async (mode) => {
      const { adapter, client, local, blobs, notify } = setup();
      const oldRead = deferred<string>();
      client.clipboardRead.mockReturnValueOnce(oldRead.promise);
      if (mode === "synchronous")
        local.write.mockImplementationOnce(() => {
          throw new Error("private browser reason");
        });
      else
        local.write.mockRejectedValueOnce(new Error("private browser reason"));
      await expect(adapter.copy()).rejects.toEqual(
        new DesktopClipboardError("copyDenied"),
      );
      expect(client.clearClipboard).toHaveBeenCalledOnce();
      expect(client.disconnect).not.toHaveBeenCalled();
      await expect(blobs[0]).rejects.toMatchObject({ code: "cancelled" });
      notify(); // RFB has no armed read now, so a late NOTIFY must not fetch/write.
      expect(client.clipboardRead).toHaveBeenCalledOnce();
      expect(local.write).toHaveBeenCalledOnce();
      const nextRead = deferred<string>();
      client.clipboardRead.mockReturnValueOnce(nextRead.promise);
      const second = adapter.copy();
      oldRead.resolve("old secret must not win");
      nextRead.resolve("fresh selection");
      await second;
      expect(await (await blobs[1])?.text()).toBe("fresh selection");
      expect(client.clipboardRead.mock.calls).toEqual([[], []]);
      expect(local.writeText).not.toHaveBeenCalled();
    },
  );
  it("disconnects if native write fails after NOTIFY has issued an uncorrelated REQUEST", async () => {
    const { adapter, client, local, blobs, notify } = setup();
    const read = deferred<string>();
    const nativeWrite = deferred<void>();
    client.clipboardRead.mockReturnValue(read.promise);
    local.write.mockReturnValue(nativeWrite.promise);
    const operation = adapter.copy();
    const rejection = expect(operation).rejects.toMatchObject({
      code: "copyDenied",
    });
    notify();
    nativeWrite.reject(new Error("denied"));
    await rejection;
    expect(client.disconnect).toHaveBeenCalledOnce();
    await expect(blobs[0]).rejects.toMatchObject({ code: "cancelled" });
    read.resolve("late");
    await expect(adapter.copy()).rejects.toMatchObject({ code: "unavailable" });
  });
  it.each(["dispose", "lost control", "disconnect"])(
    "prevents late Blob resolution after %s",
    async (reason) => {
      const { adapter, client, blobs, setActive, notify } = setup();
      const read = deferred<string>();
      client.clipboardRead.mockReturnValue(read.promise);
      const operation = adapter.copy();
      const rejection = expect(operation).rejects.toBeInstanceOf(
        DesktopClipboardError,
      );
      const blobRejection = expect(blobs[0]).rejects.toBeInstanceOf(Error);
      notify();
      if (reason === "dispose") adapter.dispose();
      else if (reason === "lost control") setActive(false);
      else read.reject(new Error("private connection reason"));
      read.resolve("late secret");
      await rejection;
      await blobRejection;
      expect(client.disconnect).toHaveBeenCalledOnce();
    },
  );
  it("keeps the terminal session after Ctrl+C produces no NOTIFY and fences late text", async () => {
    const { adapter, client, blobs, notify } = setup();
    const oldRead = deferred<string>();
    client.clipboardRead.mockReturnValueOnce(oldRead.promise);
    const operation = adapter.copy();
    const rejection = expect(operation).rejects.toMatchObject({
      code: "noCopy",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.clearClipboard).toHaveBeenCalledOnce();
    await expect(blobs[0]).rejects.toMatchObject({ code: "noCopy" });
    oldRead.resolve("stale");
    notify();
    await adapter.copy();
    expect(await (await blobs[1])?.text()).toBe("guest text");
  });
  it("disconnects on timeout after an actual read request", async () => {
    const { adapter, client, notify } = setup();
    client.clipboardRead.mockReturnValue(new Promise<string>(() => {}));
    const operation = adapter.copy();
    const rejection = expect(operation).rejects.toMatchObject({
      code: "timeout",
    });
    notify();
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(client.disconnect).toHaveBeenCalledOnce();
    await expect(adapter.copy()).rejects.toMatchObject({ code: "unavailable" });
  });
  it("disposes idempotently without disconnecting if still waiting for NOTIFY", async () => {
    const { adapter, client } = setup();
    client.clipboardRead.mockReturnValue(new Promise<string>(() => {}));
    const operation = adapter.copy();
    const rejection = expect(operation).rejects.toMatchObject({
      code: "cancelled",
    });
    adapter.dispose();
    adapter.dispose();
    await rejection;
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.clearClipboard).toHaveBeenCalledOnce();
    expect(client.removeEventListener).toHaveBeenCalledOnce();
  });
});

describe("fixed error messages", () => {
  it("never exposes browser/transport content or obsolete toolbar/fallback instructions", async () => {
    const { adapter, client } = setup();
    const secret = "TOP SECRET clipboard material";
    client.clipboardRead.mockRejectedValue(new Error(secret));
    await expect(adapter.copy()).rejects.toEqual(
      new DesktopClipboardError("transfer"),
    );
    expect(clipboardErrorMessage(new Error(secret))).toBe(
      new DesktopClipboardError("transfer").message,
    );
    expect(clipboardErrorMessage(secret)).not.toContain(secret);
    for (const code of [
      "copyDenied",
      "noCopy",
      "cancelled",
      "transfer",
    ] as const) {
      expect(new DesktopClipboardError(code).message).not.toMatch(
        /menu|toolbar|again to finish|paste text/i,
      );
    }
  });
});
