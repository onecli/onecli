// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_SUBPROTOCOL,
  DesktopView,
  type DesktopViewHandle,
} from "./desktop-view";
import { KEYBOARD_SENTINEL, XK_BACKSPACE, XK_RETURN } from "./keyboard-bridge";

/**
 * A stand-in for noVNC's `RFB`: records how it was constructed and what was
 * set on it, and lets a test fire the two events the view reacts to. The
 * real library touches `document` at import and opens a WebSocket, neither
 * of which belongs in a unit test of the React wrapper around it.
 */
const fake = vi.hoisted(() => {
  class FakeRfb extends EventTarget {
    static instances: FakeRfb[] = [];
    static failNext = false;
    viewOnly = false;
    scaleViewport = false;
    clipViewport = true;
    resizeSession = true;
    qualityLevel = 6;
    compressionLevel = 2;
    background = "";
    disconnected = false;
    focused = 0;
    keys: Array<{ keysym: number; code: string | null }> = [];
    constructor(
      public target: HTMLElement,
      public url: string,
      public options: { wsProtocols?: string[] },
    ) {
      super();
      if (FakeRfb.failNext) {
        FakeRfb.failNext = false;
        throw new Error("RFB startup failed");
      }
      FakeRfb.instances.push(this);
    }
    disconnect() {
      this.disconnected = true;
    }
    focus() {
      this.focused += 1;
    }
    sendKey(keysym: number, code: string | null) {
      if (this.viewOnly) return; // as noVNC: a watcher's keys never leave
      this.keys.push({ keysym, code });
    }
    connect() {
      this.dispatchEvent(new CustomEvent("connect", { detail: {} }));
    }
    drop() {
      this.dispatchEvent(
        new CustomEvent("disconnect", { detail: { clean: false } }),
      );
    }
  }
  return { FakeRfb, ticket: vi.fn() };
});

vi.mock("@novnc/novnc", () => ({ default: fake.FakeRfb }));
vi.mock("./api", () => ({ ticket: fake.ticket }));

const HOST = "d-andy-ab12.preview.example";
const latest = () => fake.FakeRfb.instances.at(-1)!;

/** Put the tab in the background (or bring it back) the way the browser
 * does: `document.hidden` flips, then `visibilitychange` fires. */
const hide = (hidden: boolean) => {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
};

beforeEach(() => {
  fake.FakeRfb.instances = [];
  fake.FakeRfb.failNext = false;
  fake.ticket.mockReset();
  fake.ticket.mockResolvedValue({ ticket: "tk-1" });
  hide(false);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("DesktopView", () => {
  it("retries a failed RFB startup instead of leaving Connecting forever", async () => {
    fake.FakeRfb.failNext = true;
    render(<DesktopView host={HOST} viewOnly />);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Reconnecting"),
    );
    await waitFor(() => expect(fake.FakeRfb.instances).toHaveLength(1));
    expect(fake.ticket).toHaveBeenCalledTimes(2);
  });

  it("keeps a focus request made before the ticket resolves", async () => {
    let resolveTicket: ((value: { ticket: string }) => void) | undefined;
    fake.ticket.mockReturnValue(
      new Promise<{ ticket: string }>((resolve) => {
        resolveTicket = resolve;
      }),
    );
    const view = createRef<DesktopViewHandle>();
    render(<DesktopView ref={view} host={HOST} viewOnly={false} />);
    act(() => view.current?.focus());
    await act(async () => resolveTicket?.({ ticket: "late-ticket" }));
    await waitFor(() => expect(fake.FakeRfb.instances).toHaveLength(1));
    act(() => latest().connect());
    expect(latest().focused).toBe(1);
  });

  it("mints a ticket, connects with it in the subprotocol, and tunes the client for a watched screen", async () => {
    const onStatus = vi.fn();
    render(<DesktopView host={HOST} viewOnly onStatus={onStatus} />);
    expect(screen.getByRole("status")).toHaveTextContent("Connecting…");
    await waitFor(() => expect(fake.FakeRfb.instances).toHaveLength(1));
    const rfb = latest();
    expect(fake.ticket).toHaveBeenCalledWith(HOST);
    expect(rfb.url).toBe(`wss://${HOST}/`);
    expect(rfb.options.wsProtocols).toEqual([DESKTOP_SUBPROTOCOL, "t.tk-1"]);
    expect(rfb.target).toBe(screen.getByRole("img"));
    expect(rfb.viewOnly).toBe(true);
    expect(rfb.scaleViewport).toBe(true);
    expect(rfb.clipViewport).toBe(false);
    expect(rfb.resizeSession).toBe(false);
    expect(rfb.qualityLevel).toBe(7);
    expect(rfb.compressionLevel).toBe(1);
    act(() => rfb.connect());
    expect(screen.queryByRole("status")).toBeNull();
    expect(onStatus).toHaveBeenLastCalledWith("connected");
  });

  it("flips view-only and quality live without reconnecting", async () => {
    const { rerender } = render(<DesktopView host={HOST} viewOnly />);
    await waitFor(() => expect(fake.FakeRfb.instances).toHaveLength(1));
    const rfb = latest();
    act(() => rfb.connect());
    rerender(<DesktopView host={HOST} viewOnly={false} quality={5} />);
    expect(rfb.viewOnly).toBe(false);
    expect(rfb.qualityLevel).toBe(5);
    expect(fake.FakeRfb.instances).toHaveLength(1);
    expect(fake.ticket).toHaveBeenCalledTimes(1);
  });

  it("reconnects with backoff after a drop, with a fresh ticket each time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onStatus = vi.fn();
    render(<DesktopView host={HOST} viewOnly onStatus={onStatus} />);
    await waitFor(() => expect(fake.FakeRfb.instances).toHaveLength(1));
    act(() => latest().connect());
    fake.ticket.mockResolvedValue({ ticket: "tk-2" });
    act(() => latest().drop());
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting…");
    expect(onStatus).toHaveBeenLastCalledWith("reconnecting");
    await act(() => vi.advanceTimersByTimeAsync(600));
    await waitFor(() => expect(fake.FakeRfb.instances).toHaveLength(2));
    expect(latest().options.wsProtocols).toEqual([
      DESKTOP_SUBPROTOCOL,
      "t.tk-2",
    ]);
    act(() => latest().connect());
    expect(onStatus).toHaveBeenLastCalledWith("connected");
  });

  it("a new host tears the old client down and connects to the new one", async () => {
    const { rerender } = render(<DesktopView host={HOST} viewOnly />);
    await waitFor(() => expect(fake.FakeRfb.instances).toHaveLength(1));
    const first = latest();
    act(() => first.connect());
    rerender(
      <DesktopView host="d-andy-ab12-ctl.preview.example" viewOnly={false} />,
    );
    expect(first.disconnected).toBe(true);
    await waitFor(() => expect(fake.FakeRfb.instances).toHaveLength(2));
    expect(latest().url).toBe("wss://d-andy-ab12-ctl.preview.example/");
    expect(latest().viewOnly).toBe(false);
    // The torn-down client's late events change nothing.
    act(() => first.drop());
    expect(fake.FakeRfb.instances).toHaveLength(2);
  });

  it("unmount disconnects and reports closed", async () => {
    const onStatus = vi.fn();
    const { unmount } = render(
      <DesktopView host={HOST} viewOnly onStatus={onStatus} />,
    );
    await waitFor(() => expect(fake.FakeRfb.instances).toHaveLength(1));
    const rfb = latest();
    unmount();
    expect(rfb.disconnected).toBe(true);
    expect(onStatus).toHaveBeenLastCalledWith("closed");
  });

  it("a hidden tab lets go of the stream and runs no retry; coming back reconnects with a fresh ticket", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onStatus = vi.fn();
    render(<DesktopView host={HOST} viewOnly onStatus={onStatus} />);
    await waitFor(() => expect(fake.FakeRfb.instances).toHaveLength(1));
    const first = latest();
    act(() => first.connect());
    expect(onStatus).toHaveBeenLastCalledWith("connected");

    // The tab goes to the background: the stream is dropped on purpose,
    // and nothing is scheduled to bring it back while nobody can see it.
    hide(true);
    expect(first.disconnected).toBe(true);
    expect(onStatus).toHaveBeenLastCalledWith("paused");
    expect(screen.getByRole("status")).toHaveTextContent("Paused");
    fake.ticket.mockClear();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(fake.ticket).not.toHaveBeenCalled();
    expect(fake.FakeRfb.instances).toHaveLength(1);
    // A late drop from the torn-down client changes nothing either.
    act(() => first.drop());
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(fake.FakeRfb.instances).toHaveLength(1);

    // Back on screen: a new ticket, a new client.
    fake.ticket.mockResolvedValue({ ticket: "tk-back" });
    hide(false);
    await waitFor(() => expect(fake.FakeRfb.instances).toHaveLength(2));
    expect(onStatus).toHaveBeenLastCalledWith("connecting");
    expect(latest().options.wsProtocols).toEqual([
      DESKTOP_SUBPROTOCOL,
      "t.tk-back",
    ]);
    act(() => latest().connect());
    expect(onStatus).toHaveBeenLastCalledWith("connected");
  });

  it("mounted in a hidden tab, it waits for the tab before opening anything", async () => {
    hide(true);
    const onStatus = vi.fn();
    render(<DesktopView host={HOST} viewOnly onStatus={onStatus} />);
    await act(async () => {});
    expect(fake.ticket).not.toHaveBeenCalled();
    expect(fake.FakeRfb.instances).toHaveLength(0);
    expect(onStatus).toHaveBeenLastCalledWith("paused");
    hide(false);
    await waitFor(() => expect(fake.FakeRfb.instances).toHaveLength(1));
  });

  it("Esc while driving asks to let go; while watching it is just a key", async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    const { rerender } = render(
      <DesktopView host={HOST} viewOnly onEscape={onEscape} />,
    );
    await waitFor(() => expect(fake.FakeRfb.instances).toHaveLength(1));
    const canvasHost = screen.getByRole("img");
    canvasHost.tabIndex = 0;
    canvasHost.focus();
    await user.keyboard("{Escape}");
    expect(onEscape).not.toHaveBeenCalled();
    rerender(<DesktopView host={HOST} viewOnly={false} onEscape={onEscape} />);
    canvasHost.focus();
    await user.keyboard("{Escape}");
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("exposes focus() so Take control can land keystrokes on the screen", async () => {
    const ref = createRef<DesktopViewHandle>();
    render(<DesktopView ref={ref} host={HOST} viewOnly={false} />);
    await waitFor(() => expect(fake.FakeRfb.instances).toHaveLength(1));
    ref.current?.focus();
    expect(latest().focused).toBe(1);
  });

  it("a ticket the api refuses is retried, not fatal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fake.ticket.mockRejectedValueOnce(new Error("403"));
    render(<DesktopView host={HOST} viewOnly />);
    await waitFor(() => expect(fake.ticket).toHaveBeenCalledTimes(1));
    expect(fake.FakeRfb.instances).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(600));
    await waitFor(() => expect(fake.FakeRfb.instances).toHaveLength(1));
  });

  describe("the phone keyboard bridge", () => {
    const field = () =>
      screen.getByLabelText(
        "Type on the agent's screen",
      ) as HTMLTextAreaElement;
    const typeInto = (value: string) => {
      const el = field();
      act(() => {
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    it("is absent while watching: there is nothing to type into", async () => {
      render(<DesktopView host={HOST} viewOnly />);
      await waitFor(() => expect(fake.FakeRfb.instances).toHaveLength(1));
      expect(screen.queryByLabelText("Type on the agent's screen")).toBeNull();
    });

    it("openKeyboard focuses the field, and what the keyboard types reaches the screen as keysyms", async () => {
      const view = createRef<DesktopViewHandle>();
      render(<DesktopView ref={view} host={HOST} viewOnly={false} />);
      await waitFor(() => expect(fake.FakeRfb.instances).toHaveLength(1));
      act(() => latest().connect());
      act(() => view.current?.openKeyboard());
      expect(document.activeElement).toBe(field());
      expect(field().value).toBe(KEYBOARD_SENTINEL);
      typeInto(`${KEYBOARD_SENTINEL}Hi`);
      // Sent, then cleared at once: a password typed here never lingers.
      expect(field().value).toBe(KEYBOARD_SENTINEL);
      typeInto(KEYBOARD_SENTINEL.slice(1)); // BackSpace
      typeInto(`${KEYBOARD_SENTINEL}\n`);
      expect(latest().keys.map((k) => k.keysym)).toEqual([
        0x48,
        0x69,
        XK_BACKSPACE,
        XK_RETURN,
      ]);
      expect(field().value).toBe(KEYBOARD_SENTINEL);
    });

    it("waits for an IME composition to commit before typing it", async () => {
      const view = createRef<DesktopViewHandle>();
      render(<DesktopView ref={view} host={HOST} viewOnly={false} />);
      await waitFor(() => expect(fake.FakeRfb.instances).toHaveLength(1));
      act(() => latest().connect());
      act(() => view.current?.openKeyboard());
      const el = field();
      act(() => {
        el.dispatchEvent(new Event("compositionstart", { bubbles: true }));
      });
      typeInto(`${KEYBOARD_SENTINEL}ni`);
      expect(latest().keys).toEqual([]);
      act(() => {
        el.value = `${KEYBOARD_SENTINEL}你`;
        el.dispatchEvent(new Event("compositionend", { bubbles: true }));
      });
      expect(latest().keys.map((k) => k.keysym)).toEqual([0x01000000 + 0x4f60]);
    });

    it("a long paste is typed in full and the field is empty again after", async () => {
      const view = createRef<DesktopViewHandle>();
      render(<DesktopView ref={view} host={HOST} viewOnly={false} />);
      await waitFor(() => expect(fake.FakeRfb.instances).toHaveLength(1));
      act(() => latest().connect());
      act(() => view.current?.openKeyboard());
      typeInto(`${KEYBOARD_SENTINEL}${"x".repeat(300)}`);
      expect(latest().keys).toHaveLength(300);
      expect(field().value).toBe(KEYBOARD_SENTINEL);
      typeInto(`${KEYBOARD_SENTINEL}y`);
      expect(latest().keys.at(-1)?.keysym).toBe(0x79);
      expect(latest().keys).toHaveLength(301);
    });

    it("keeps password managers off the field", async () => {
      render(<DesktopView host={HOST} viewOnly={false} />);
      await waitFor(() => expect(fake.FakeRfb.instances).toHaveLength(1));
      expect(field()).toHaveAttribute("autocomplete", "off");
      expect(field()).toHaveAttribute("data-1p-ignore");
      expect(field()).toHaveAttribute("data-lpignore", "true");
    });
  });
});
