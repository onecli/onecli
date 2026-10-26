// @vitest-environment jsdom
import { createRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopState } from "./api";
import type { DesktopViewProps } from "./desktop-view";
import { DesktopDock, type DesktopDockHandle } from "./desktop-dock";
import { DesktopHeaderChip } from "./desktop-header-chip";

const mocks = vi.hoisted(() => ({
  pathname: "/w/ws/agents/andy/chat",
  data: { current: null as DesktopState | null },
  wake: vi.fn(),
  take: vi.fn(),
  release: vi.fn(),
  error: vi.fn(),
  streams: { active: 0, peak: 0 },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}));
vi.mock("sonner", () => ({ toast: { error: mocks.error, success: vi.fn() } }));
vi.mock("./use-desktop", () => ({
  useDesktop: () => ({ data: mocks.data.current }),
  useWakeDesktop: () => ({ mutate: mocks.wake, isPending: false }),
  useTakeControl: () => ({ mutate: mocks.take, isPending: false }),
  useReleaseControl: () => ({ mutate: mocks.release, isPending: false }),
}));
vi.mock("./desktop-view", () => ({
  QUALITY_CARD: 5,
  QUALITY_THEATER: 7,
  DesktopView: ({
    ref,
    onStatus,
    onEscape,
    host,
    quality,
  }: DesktopViewProps) => {
    const canvas = useRef<HTMLCanvasElement>(null);
    useImperativeHandle(
      ref,
      () => ({
        focus: () => canvas.current?.focus(),
        openKeyboard: () => undefined,
      }),
      [],
    );
    useEffect(() => {
      mocks.streams.active++;
      mocks.streams.peak = Math.max(mocks.streams.active, mocks.streams.peak);
      onStatus?.("connected");
      return () => {
        mocks.streams.active--;
      };
    }, [onStatus]);
    return (
      <canvas
        ref={canvas}
        tabIndex={0}
        data-testid="stream"
        data-host={host}
        data-quality={quality}
        // The real view's capture-phase Esc, fired only while driving.
        onKeyDown={(event) => {
          if (event.key === "Escape") onEscape?.();
        }}
      />
    );
  },
}));

const awake = (): DesktopState => ({
  available: true,
  sandboxState: "awake",
  viewHost: "watch.example",
  controlHost: null,
  controller: null,
  request: null,
  you: { controlling: false },
});
const ASK_ID = "0b4a1c5e-1111-4222-8333-444455556666";
const asking = (): DesktopState => ({
  ...awake(),
  request: { id: ASK_ID, reason: "Sign in", at: "2026-10-18T00:00:00Z" },
});
const unavailableStates: DesktopState["sandboxState"][] = [
  "asleep",
  "waking",
  "unviewable",
  "awake",
];
// The page as it renders: the header's chip beside the chat's dock.
const mount = (props: Partial<React.ComponentProps<typeof DesktopDock>> = {}) =>
  render(
    <>
      <DesktopHeaderChip agentId="andy" agentName="Andy" />
      <DesktopDock agentId="andy" agentName="Andy" {...props} />
    </>,
  );
const open = async () => {
  await userEvent.click(
    screen.getByRole("button", { name: "Open Andy’s screen" }),
  );
  return screen.findByRole("dialog");
};

beforeEach(() => {
  mocks.data.current = awake();
  mocks.streams.active = 0;
  mocks.streams.peak = 0;
  vi.clearAllMocks();
  localStorage.clear();
  // Most of these tests start from the open card: the person chose it once.
  localStorage.setItem(
    "onecli:desktop-dock:andy",
    JSON.stringify({ mode: "card", chat: false, corner: "bottom-right" }),
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: !query.includes("reduced-motion"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DesktopDock with the real DialogStage shell", () => {
  it("collapses an open theater to the stream-free header button when the viewport becomes narrow", async () => {
    let wide = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: !query.includes("reduced-motion") && wide,
      addEventListener: (_event: string, listener: () => void) =>
        listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) =>
        listeners.delete(listener),
    }));
    mount();
    await open();
    act(() => {
      wide = false;
      listeners.forEach((listener) => listener());
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId("stream")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Andy’s Computer" }),
    ).toBeInTheDocument();
    expect(mocks.streams.active).toBe(0);
  });

  it("has exactly one stream and transition name across expand/close, then restores focus without a DialogTrigger", async () => {
    mount();
    expect(screen.getByTestId("stream")).toHaveAttribute("data-quality", "5");
    await open();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("stream")).toHaveAttribute("data-quality", "7");
    expect(
      document.querySelectorAll('[style*="view-transition-name"]'),
    ).toHaveLength(1);
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open Andy’s screen" }),
      ).toHaveFocus(),
    );
    expect(mocks.streams.active).toBe(1);
    expect(mocks.streams.peak).toBe(1);
  });

  it("unmounts the theater stream while Radix retains its exit-animated shell", async () => {
    const style = document.createElement("style");
    style.textContent =
      '[data-slot="dialog-stage"][data-state="open"] { animation-name: enter; } [data-slot="dialog-stage"][data-state="closed"] { animation-name: exit; }';
    document.head.append(style);
    try {
      mount();
      const dialog = await open();
      await userEvent.click(
        screen.getByRole("button", { name: "Back to the chat" }),
      );
      expect(dialog).toHaveAttribute("data-state", "closed");
      expect(dialog.querySelector("canvas")).toBeNull();
      expect(screen.getAllByTestId("stream")).toHaveLength(1);
      expect(
        document.querySelectorAll('[style*="view-transition-name"]'),
      ).toHaveLength(1);
      expect(mocks.streams.peak).toBe(1);
      fireEvent.animationEnd(dialog, { animationName: "exit" });
    } finally {
      style.remove();
    }
  });

  it("starts minimized: only the header button, named for the agent, and no stream", async () => {
    localStorage.clear();
    mount();
    const chip = await screen.findByRole("button", {
      name: "Andy’s Computer",
    });
    expect(chip).toHaveTextContent("Andy’s Computer");
    expect(screen.queryByText("Andy’s screen")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Minimize the computer" }),
    ).not.toBeInTheDocument();
    expect(mocks.streams.active).toBe(0);
    await userEvent.click(chip);
    expect(mocks.streams.active).toBe(1);
  });

  it("Esc tucks the open card back into the header button and returns to typing", async () => {
    const host = document.createElement("div");
    const composer = document.createElement("textarea");
    host.append(composer);
    document.body.append(host);
    try {
      mount({ theaterChatHost: host });
      expect(mocks.streams.active).toBe(1);
      await userEvent.keyboard("{Escape}");
      expect(mocks.streams.active).toBe(0);
      expect(
        screen.getByRole("button", { name: "Andy’s Computer" }),
      ).toBeInTheDocument();
      await waitFor(() => expect(composer).toHaveFocus());
    } finally {
      host.remove();
    }
  });

  it("Esc leaves the card open while a message is half-typed", async () => {
    const draft = document.createElement("textarea");
    document.body.append(draft);
    try {
      mount();
      draft.focus();
      await userEvent.type(draft, "not done yet");
      await userEvent.keyboard("{Escape}");
      expect(mocks.streams.active).toBe(1);
      expect(
        screen.getByRole("button", { name: "Minimize the computer" }),
      ).toBeInTheDocument();
    } finally {
      draft.remove();
    }
  });

  it("minimizes to the header button with no stream, nothing over the chat, and restores the card with focus", async () => {
    mount();
    expect(
      screen.queryByRole("button", { name: "Andy’s Computer" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Andy’s screen")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Minimize the computer" }),
    );
    expect(mocks.streams.active).toBe(0);
    const chip = screen.getByRole("button", { name: "Andy’s Computer" });
    // The card's caption went with the card; the header carries no caption.
    expect(screen.queryByText("Andy’s screen")).not.toBeInTheDocument();
    await waitFor(() => expect(chip).toHaveFocus());
    await userEvent.click(chip);
    expect(mocks.streams.active).toBe(1);
    expect(
      screen.queryByRole("button", { name: "Andy’s Computer" }),
    ).not.toBeInTheDocument();
    // The button left with focus on it: focus lands on the card instead.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open Andy’s screen" }),
      ).toHaveFocus(),
    );
  });

  it("off the chat, the header button is a link to the full-page computer", () => {
    mocks.pathname = "/w/ws/agents/andy/skills";
    try {
      render(<DesktopHeaderChip agentId="andy" agentName="Andy" />);
      expect(
        screen.getByRole("link", { name: "Andy’s Computer" }),
      ).toHaveAttribute("href", "/w/ws/agents/andy/computer");
    } finally {
      mocks.pathname = "/w/ws/agents/andy/chat";
    }
  });

  it("off the chat, an ask links straight to it, so the page focuses Take control", () => {
    mocks.pathname = "/w/ws/agents/andy/skills";
    mocks.data.current = asking();
    try {
      render(<DesktopHeaderChip agentId="andy" agentName="Andy" />);
      const link = screen.getByRole("link", {
        name: "Needs you on Andy’s computer: Sign in",
      });
      expect(link).toHaveTextContent(/^Needs you$/);
      expect(link).toHaveAttribute(
        "href",
        `/w/ws/agents/andy/computer?takeover=${ASK_ID}`,
      );
    } finally {
      mocks.pathname = "/w/ws/agents/andy/chat";
    }
  });

  it("names the agent on the header button only up to six characters, and always in its accessible name", () => {
    mocks.pathname = "/w/ws/agents/andy/skills";
    try {
      const { unmount } = render(
        <DesktopHeaderChip agentId="andy" agentName="Donna2" />,
      );
      const named = screen.getByRole("link", { name: "Donna2’s Computer" });
      expect(named).toHaveTextContent(/^Donna2’s Computer$/);
      // On a phone the title beside it already names the agent: the name
      // folds away there and the button reads "Computer".
      expect(screen.getByText("Donna2’s")).toHaveClass("max-sm:hidden");
      unmount();
      render(<DesktopHeaderChip agentId="andy" agentName="Marcus7" />);
      // The visible word stays inside the accessible name (label in name).
      expect(
        screen.getByRole("link", { name: "Marcus7’s Computer" }),
      ).toHaveTextContent(/^Computer$/);
    } finally {
      mocks.pathname = "/w/ws/agents/andy/chat";
    }
  });

  it("on the chat, the header button waits for the dock rather than navigating away", () => {
    render(<DesktopHeaderChip agentId="andy" agentName="Andy" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("once the chat's dock unmounts, the header button falls back to the link", () => {
    localStorage.clear();
    const { rerender } = render(
      <>
        <DesktopHeaderChip agentId="andy" agentName="Andy" />
        <DesktopDock agentId="andy" agentName="Andy" />
      </>,
    );
    expect(
      screen.getByRole("button", { name: "Andy’s Computer" }),
    ).toBeInTheDocument();
    mocks.pathname = "/w/ws/agents/andy/skills";
    try {
      rerender(<DesktopHeaderChip agentId="andy" agentName="Andy" />);
      expect(
        screen.getByRole("link", { name: "Andy’s Computer" }),
      ).toHaveAttribute("href", "/w/ws/agents/andy/computer");
    } finally {
      mocks.pathname = "/w/ws/agents/andy/chat";
    }
  });

  it("opens an asleep card without waking, and only explicit Wake mutates", async () => {
    mocks.data.current = {
      ...awake(),
      available: false,
      sandboxState: "asleep",
      viewHost: null,
    };
    mount();
    expect(screen.getByText("Asleep")).toBeInTheDocument();
    await open();
    expect(mocks.wake).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(await screen.findByRole("button", { name: "Wake" }));
    expect(mocks.wake).toHaveBeenCalledOnce();
  });

  it("pending ask: the header button opens directly into the theater", async () => {
    mocks.data.current = asking();
    mount();
    await userEvent.click(
      screen.getByRole("button", { name: "Minimize the computer" }),
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Needs you on Andy’s computer: Sign in",
      }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/Sign in/)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Take control" }),
      ).toHaveFocus(),
    );
  });

  it("pending ask with no room for the overlay: the full page, deep-linked to the ask", async () => {
    mocks.data.current = asking();
    localStorage.clear();
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    mount();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Needs you on Andy’s computer: Sign in",
      }),
    );
    expect(assign).toHaveBeenCalledWith(
      `/w/ws/agents/andy/computer?takeover=${ASK_ID}`,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Take control focuses the canvas after mutation succeeds", async () => {
    mocks.take.mockImplementation(
      (_input: undefined, options: { onSuccess: () => void }) =>
        options.onSuccess(),
    );
    mount();
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(screen.getByTestId("stream")).toHaveFocus());
  });

  it("exposes and clears imperative object and callback refs", async () => {
    const ref = createRef<DesktopDockHandle>();
    const { unmount } = mount({ openRef: ref });
    act(() => ref.current?.expand());
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    unmount();
    expect(ref.current).toBeNull();
    const callback = vi.fn();
    const next = mount({ openRef: callback });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ expand: expect.any(Function) }),
    );
    next.unmount();
    expect(callback).toHaveBeenLastCalledWith(null);
  });

  it("scrim closes, while Escape on the controller canvas moves to Stop and keeps the theater open", async () => {
    mocks.data.current = {
      ...awake(),
      controlHost: "control.example",
      you: { controlling: true },
    };
    mount();
    expect(screen.getByTestId("stream")).toHaveAttribute(
      "data-host",
      "watch.example",
    );
    const dialog = await open();
    const canvas = screen.getByTestId("stream");
    act(() => canvas.focus());
    await userEvent.keyboard("{Escape}");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toHaveFocus();
    expect(mocks.release).not.toHaveBeenCalled();
    fireEvent.pointerDown(dialog);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("retains the theater on blocked popout and minimizes on success", async () => {
    const popup = vi.spyOn(window, "open").mockReturnValue(null);
    mount();
    await open();
    await userEvent.click(
      screen.getByRole("button", { name: "Open in its own window" }),
    );
    expect(mocks.error).toHaveBeenCalledWith(
      expect.stringContaining("Pop-up blocked"),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    popup.mockReturnValue(window);
    await userEvent.click(
      screen.getByRole("button", { name: "Open in its own window" }),
    );
    expect(popup).toHaveBeenLastCalledWith(
      "/w/ws/agents/andy/computer",
      "onecli-desktop-andy",
      "popup=yes,width=1280,height=860",
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(mocks.streams.active).toBe(0);
    expect(
      screen.getByRole("button", { name: "Andy’s Computer" }),
    ).toBeInTheDocument();
  });

  it.each(unavailableStates)(
    "keeps Chat reachable while the %s screen is unavailable",
    async (sandboxState) => {
      mocks.data.current = {
        ...awake(),
        available: false,
        sandboxState,
        viewHost: null,
      };
      const parent = document.createElement("div");
      const host = document.createElement("div");
      const draft = document.createElement("textarea");
      draft.setAttribute("aria-label", "Chat draft");
      host.append(draft);
      parent.append(host);
      document.body.append(parent);
      try {
        mount({ theaterChatHost: host });
        await open();
        expect(mocks.streams.active).toBe(0);
        expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
        const toggle = screen.getByRole("button", { name: "Chat" });
        expect(toggle).toHaveAttribute("aria-pressed", "false");
        expect(
          screen.queryByRole("textbox", { name: "Chat draft" }),
        ).not.toBeInTheDocument();
        await userEvent.click(toggle);
        expect(toggle).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("textbox", { name: "Chat draft" })).toBe(draft);
        await userEvent.type(draft, "Still here while the computer starts");
        await userEvent.click(toggle);
        expect(
          screen.queryByRole("textbox", { name: "Chat draft" }),
        ).not.toBeInTheDocument();
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        await userEvent.keyboard("{Escape}");
        await waitFor(() => expect(parent.firstChild).toBe(host));
        expect(draft.value).toBe("Still here while the computer starts");
        expect(mocks.wake).not.toHaveBeenCalled();
      } finally {
        cleanup();
        parent.remove();
      }
    },
  );

  it("the control bar receives pointer events, and Stop hands back without closing the theater", async () => {
    // jsdom does not load Tailwind. Exercise the actual pointer utility
    // declarations so a missing pointer-events-auto on the bar is observable.
    const style = document.createElement("style");
    style.textContent =
      ".pointer-events-none { pointer-events: none; } .pointer-events-auto { pointer-events: auto; }";
    document.head.append(style);
    mocks.data.current = {
      ...awake(),
      controlHost: "control.example",
      you: { controlling: true },
    };
    try {
      mount();
      await open();
      const bar = screen.getByRole("toolbar", { name: "Desktop control" });
      expect(window.getComputedStyle(bar).pointerEvents).toBe("auto");
      await userEvent.click(screen.getByRole("button", { name: "Stop" }));
      expect(mocks.release).toHaveBeenCalledOnce();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    } finally {
      cleanup();
      style.remove();
    }
  });

  it("moves the same chat host into the dialog and restores its identity and draft on close", async () => {
    const parent = document.createElement("div");
    const host = document.createElement("div");
    const draft = document.createElement("textarea");
    draft.value = "unsent draft";
    host.append(draft);
    parent.append(host);
    document.body.append(parent);
    try {
      mount({ theaterChatHost: host });
      await open();
      await userEvent.click(screen.getByRole("button", { name: "Chat" }));
      const aside = screen.getByRole("complementary", {
        name: "Chat with Andy",
      });
      expect(aside.firstChild).toBe(host);
      expect(host.firstChild).toBe(draft);
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(parent.firstChild).toBe(host));
      expect(draft.value).toBe("unsent draft");
      await open();
      expect(screen.getByRole("complementary").firstChild).toBe(host);
    } finally {
      cleanup();
      parent.remove();
    }
  });
});
