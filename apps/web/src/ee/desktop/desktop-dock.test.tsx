// @vitest-environment jsdom
import { createRef, useEffect, useImperativeHandle, useRef } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
        cancelClipboard: () => undefined,
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
  return screen.findByRole("region", { name: "Andy’s computer" });
};
const stage = () => screen.queryByRole("region", { name: "Andy’s computer" });

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

describe("DesktopDock", () => {
  it("starts minimized: only the header button, then a click opens the card", async () => {
    localStorage.clear();
    mount();
    const chip = await screen.findByRole("button", {
      name: "Andy’s Computer",
    });
    expect(chip).toHaveTextContent("Andy’s Computer");
    expect(
      screen.queryByRole("button", { name: "Open Andy’s screen" }),
    ).not.toBeInTheDocument();
    expect(mocks.streams.active).toBe(0);
    await userEvent.click(chip);
    expect(mocks.streams.active).toBe(1);
    expect(screen.getByTestId("stream")).toHaveAttribute("data-quality", "5");
    expect(screen.getByText("Computer")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Andy’s Computer" }),
    ).not.toBeInTheDocument();
  });

  it("the title bar's expand button grows the card like a click on the screen", async () => {
    mount();
    await userEvent.click(
      screen.getByRole("button", { name: "Expand to the full chat" }),
    );
    expect(await screen.findByRole("region", { name: "Andy’s computer" }));
  });

  it("collapses the grown computer to the stream-free header button when the viewport becomes narrow", async () => {
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
    await waitFor(() => expect(stage()).not.toBeInTheDocument());
    expect(screen.queryByTestId("stream")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Andy’s Computer" }),
    ).toBeInTheDocument();
    expect(mocks.streams.active).toBe(0);
  });

  it("has exactly one stream and transition name across expand and Esc, then returns to the card with focus", async () => {
    mount();
    expect(screen.getByTestId("stream")).toHaveAttribute("data-quality", "5");
    await open();
    expect(screen.getByTestId("stream")).toHaveAttribute("data-quality", "7");
    expect(
      document.querySelectorAll('[style*="view-transition-name"]'),
    ).toHaveLength(1);
    // Grown, it needs no opener in the header.
    expect(
      screen.queryByRole("button", { name: "Andy’s Computer" }),
    ).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(stage()).not.toBeInTheDocument());
    // Esc went back to the card, not past it to the header button.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open Andy’s screen" }),
      ).toHaveFocus(),
    );
    expect(mocks.streams.active).toBe(1);
    expect(mocks.streams.peak).toBe(1);
  });

  it("Back to chat swaps the stage's stream for the card's, never both at once", async () => {
    mount();
    await open();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Back to chat" }),
      ).toHaveFocus(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(stage()).not.toBeInTheDocument();
    expect(screen.getAllByTestId("stream")).toHaveLength(1);
    expect(screen.getByTestId("stream")).toHaveAttribute("data-quality", "5");
    expect(mocks.streams.peak).toBe(1);
  });

  it("grows over the conversation but leaves the chat host where it is, so the composer stays in reach", async () => {
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
      expect(parent.firstChild).toBe(host);
      expect(host.firstChild).toBe(draft);
      expect(
        screen.queryByRole("button", { name: "Chat" }),
      ).not.toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(draft.value).toBe("unsent draft");
    } finally {
      cleanup();
      parent.remove();
    }
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
    await userEvent.click(
      screen.getByRole("button", { name: "Minimize the computer" }),
    );
    expect(mocks.streams.active).toBe(0);
    expect(
      screen.queryByRole("button", { name: "Open Andy’s screen" }),
    ).not.toBeInTheDocument();
    const chip = screen.getByRole("button", { name: "Andy’s Computer" });
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
    localStorage.setItem(
      "onecli:desktop-dock:andy",
      JSON.stringify({ mode: "chip", chat: false, corner: "bottom-right" }),
    );
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
    expect(screen.getAllByText("Asleep").length).toBeGreaterThan(0);
    await open();
    expect(mocks.wake).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(stage()).not.toBeInTheDocument());
    await userEvent.click(await screen.findByRole("button", { name: "Wake" }));
    expect(mocks.wake).toHaveBeenCalledOnce();
  });

  it("pending ask: the header button grows the computer straight away, onto Take control", async () => {
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
    expect(stage()).toBeInTheDocument();
    expect(screen.getAllByText(/Sign in/).length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Take control" }),
      ).toHaveFocus(),
    );
  });

  it("pending ask with no room in the chat: the full page, deep-linked to the ask", async () => {
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
    expect(stage()).not.toBeInTheDocument();
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
    expect(
      await screen.findByRole("region", { name: "Andy’s computer" }),
    ).toBeInTheDocument();
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

  it("Escape on the controller canvas moves to Stop and keeps the computer grown", async () => {
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
    await open();
    const canvas = screen.getByTestId("stream");
    act(() => canvas.focus());
    await userEvent.keyboard("{Escape}");
    expect(stage()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toHaveFocus();
    expect(mocks.release).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(stage()).not.toBeInTheDocument();
  });

  it("stays grown on a blocked pop-out and minimizes on success", async () => {
    const popup = vi.spyOn(window, "open").mockReturnValue(null);
    mount();
    await open();
    await userEvent.click(
      screen.getByRole("button", { name: "Open in its own window" }),
    );
    expect(mocks.error).toHaveBeenCalledWith(
      expect.stringContaining("Pop-up blocked"),
    );
    expect(stage()).toBeInTheDocument();
    popup.mockReturnValue(window);
    await userEvent.click(
      screen.getByRole("button", { name: "Open in its own window" }),
    );
    expect(popup).toHaveBeenLastCalledWith(
      "/w/ws/agents/andy/computer",
      "onecli-desktop-andy",
      "popup=yes,width=1280,height=860",
    );
    await waitFor(() => expect(stage()).not.toBeInTheDocument());
    expect(mocks.streams.active).toBe(0);
    expect(
      screen.getByRole("button", { name: "Andy’s Computer" }),
    ).toBeInTheDocument();
  });

  it.each(unavailableStates)(
    "grows a %s computer without a stream or a control bar",
    async (sandboxState) => {
      mocks.data.current = {
        ...awake(),
        available: false,
        sandboxState,
        viewHost: null,
      };
      mount();
      await open();
      expect(mocks.streams.active).toBe(0);
      expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
      expect(mocks.wake).not.toHaveBeenCalled();
    },
  );

  it("the control bar receives pointer events, and Stop hands back without shrinking the computer", async () => {
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
      expect(stage()).toBeInTheDocument();
    } finally {
      cleanup();
      style.remove();
    }
  });
});
