// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import type { DesktopState } from "./api";

const state = vi.hoisted(() => ({
  data: undefined as DesktopState | undefined,
  isPending: false,
  isError: false,
  refetch: vi.fn(),
  wake: vi.fn(),
  take: vi.fn(),
  release: vi.fn(),
  search: "",
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/agents/ag-1/computer",
  useSearchParams: () => new URLSearchParams(state.search),
}));
vi.mock("./use-desktop", () => ({
  useDesktop: () => state,
  useWakeDesktop: () => ({ mutate: state.wake, isPending: false }),
  useTakeControl: () => ({ mutate: state.take, isPending: false }),
  useReleaseControl: () => ({ mutate: state.release, isPending: false }),
}));
vi.mock("./desktop-view", () => ({
  QUALITY_THEATER: 7,
  DesktopView: ({ onStatus }: { onStatus: (status: string) => void }) => {
    useEffect(() => onStatus("connected"), [onStatus]);
    return <div data-testid="screen" />;
  },
}));
vi.mock(
  "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/_components/agent-page-frame",
  () => ({
    useAgentPageAgent: () => ({ id: "ag-1", name: "andy", kind: "hosted" }),
  }),
);
const { DesktopTheaterPage } = await import("./desktop-theater-page");
const desktop = (overrides: Partial<DesktopState> = {}): DesktopState => ({
  available: true,
  sandboxState: "awake",
  viewHost: "desktop.preview.example",
  controlHost: null,
  controller: null,
  request: null,
  you: { controlling: false },
  ...overrides,
});
beforeEach(() => {
  vi.clearAllMocks();
  state.data = desktop();
  state.isPending = false;
  state.isError = false;
  state.search = "";
  window.history.replaceState(null, "", "/w/ws-1/agents/ag-1/computer");
});
afterEach(cleanup);

describe("DesktopTheaterPage", () => {
  it("focuses Take control for a valid deep link without acquiring a lease", () => {
    state.search = "takeover=0b4a1c5e-1111-4222-8333-444455556666";
    window.history.replaceState(null, "", `?${state.search}`);
    render(<DesktopTheaterPage />);
    expect(screen.getByRole("button", { name: "Take control" })).toHaveFocus();
    expect(state.take).not.toHaveBeenCalled();
  });
  it("shows the agent and workspace-scoped exits around one screen", () => {
    render(<DesktopTheaterPage />);
    expect(screen.getByText("andy")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Computer" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open chat" })).toHaveAttribute(
      "href",
      "/w/ws-1/agents/ag-1/chat",
    );
    expect(screen.getByRole("link", { name: "Open chat" })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(
      screen.getByRole("link", { name: "Open dashboard" }),
    ).toHaveAttribute("href", "/w/ws-1/agents");
    expect(screen.getAllByTestId("screen")).toHaveLength(1);
  });
  it("retains loading and retry without mounting a screen", async () => {
    state.isPending = true;
    const { rerender } = render(<DesktopTheaterPage />);
    expect(screen.getByLabelText("Loading computer")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.queryByTestId("screen")).toBeNull();
    state.isPending = false;
    state.isError = true;
    rerender(<DesktopTheaterPage />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(state.refetch).toHaveBeenCalledOnce();
  });
  it("consumes takeover while preserving query, hash and history state, with asleep context", () => {
    state.search = "takeover=0b4a1c5e-1111-4222-8333-444455556666&x=1";
    window.history.replaceState(
      { marker: true },
      "",
      `/w/ws-1/agents/ag-1/computer?${state.search}#screen`,
    );
    state.data = desktop({
      sandboxState: "asleep",
      available: false,
      viewHost: null,
    });
    render(<DesktopTheaterPage />);
    expect(window.location.search).toBe("?x=1");
    expect(window.location.hash).toBe("#screen");
    expect(window.history.state).toEqual({ marker: true });
    expect(screen.getByText(/The agent asked for help/)).toBeInTheDocument();
    expect(state.take).not.toHaveBeenCalled();
  });
  it("consumes invalid takeover values without trusting them", () => {
    state.search = "takeover=junk";
    window.history.replaceState(null, "", `?${state.search}`);
    render(<DesktopTheaterPage />);
    expect(window.location.search).toBe("");
    expect(screen.queryByText(/The agent asked for help/)).toBeNull();
    expect(state.take).not.toHaveBeenCalled();
  });
  it("shows the shared pending ask and leaves control explicit", async () => {
    state.data = desktop({
      request: {
        id: "req",
        reason: "Please sign in",
        at: "2026-10-18T00:00:00Z",
      },
    });
    render(<DesktopTheaterPage />);
    expect(screen.getByText(/Please sign in/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Take control" }));
    expect(state.take).toHaveBeenCalledOnce();
  });
});
