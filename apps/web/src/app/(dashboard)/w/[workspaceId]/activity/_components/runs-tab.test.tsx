// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { RunListItem, RunsPage } from "@/lib/api/runs";

/**
 * Runs mirrors Network: one segmented filter (a source, or Failed), a Live
 * switch, and a table. A colleague's private run shows its facts, never its
 * text, and the Apps column appears only when app evidence is available.
 */
const hook = vi.hoisted(() => ({
  filters: [] as Record<string, unknown>[],
  setLive: vi.fn(),
  page: null as RunsPage | null,
}));
vi.mock("@/hooks/use-runs", () => ({
  useRunsList: (filter: Record<string, unknown>) => {
    hook.filters.push(filter);
    return {
      pages: hook.page ? [hook.page] : [],
      isPending: false,
      isError: false,
      hasMore: false,
      isLoadingMore: false,
      loadMore: vi.fn(),
      live: true,
      setLive: hook.setLive,
    };
  },
}));
vi.mock("@/lib/agents/runs", () => ({ RunDetailSheet: () => null }));
vi.mock("next/image", () => ({
  default: ({ alt }: { alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt ?? ""} />
  ),
}));

const { RunsTab } = await import("./runs-tab");

const facts = {
  conversationId: "c1",
  agent: { id: "ag-1", name: "Donna" },
  direct: false,
  status: "failed",
  askedBy: null,
  appAttribution: "withheld",
  appsUsed: [],
  createdAt: "2026-09-01T10:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  durationMs: 2500,
} satisfies Partial<RunListItem>;
const shared = (
  patch: Partial<Extract<RunListItem, { private: false }>> = {},
): RunListItem => ({
  ...facts,
  turnId: "t1",
  source: "webhook",
  private: false,
  question: "Summarize the meeting",
  answer: null,
  error: null,
  toolNames: [],
  ...patch,
});
const page = (runs: RunListItem[], appEvidenceWithheld = true): RunsPage => ({
  runs,
  nextBefore: null,
  isAdmin: !appEvidenceWithheld,
  appEvidenceWithheld,
});
const last = () => hook.filters.at(-1);

beforeEach(() => {
  hook.filters = [];
  hook.setLive.mockReset();
  hook.page = page([shared()]);
});

describe("Activity Runs tab", () => {
  it("starts on All, scoped to the URL's agent", () => {
    render(<RunsTab agentId="ag-1" onViewNetwork={vi.fn()} />);
    expect(last()).toEqual({ agentId: "ag-1" });
  });

  it("one segmented filter: a source, or Failed", () => {
    render(<RunsTab onViewNetwork={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Webhooks" }));
    expect(last()).toEqual({ source: "webhook" });
    fireEvent.click(screen.getByRole("button", { name: "Failed" }));
    expect(last()).toEqual({ failed: true });
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(last()).toEqual({});
  });

  it("the Live switch toggles the list's Live mode", () => {
    render(<RunsTab onViewNetwork={vi.fn()} />);
    const live = screen.getByRole("button", { name: "Live" });
    expect(live).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(live);
    expect(hook.setLive).toHaveBeenCalledWith(false);
  });

  it("renders a run as a row: agent, source, question, status, duration", () => {
    render(<RunsTab onViewNetwork={vi.fn()} />);
    expect(screen.getByText("Donna")).toBeInTheDocument();
    expect(screen.getByText("Webhook")).toBeInTheDocument();
    expect(screen.getByText("Summarize the meeting")).toBeInTheDocument();
    expect(screen.getByText("Failed", { selector: "span" })).toBeVisible();
    expect(screen.getByText("2.5 s")).toBeInTheDocument();
  });

  it("shows a colleague's private run without any of its text", () => {
    hook.page = page([
      {
        ...facts,
        turnId: "t2",
        source: "web",
        direct: true,
        private: true,
      },
    ]);
    render(<RunsTab onViewNetwork={vi.fn()} />);
    expect(screen.getByText("Private chat. Open to read it.")).toBeVisible();
    expect(screen.getByText("Donna")).toBeInTheDocument();
  });

  it("hides the Apps column when app evidence is withheld", () => {
    render(<RunsTab onViewNetwork={vi.fn()} />);
    expect(
      screen.queryByRole("columnheader", { name: "Apps" }),
    ).not.toBeInTheDocument();
  });

  it("shows each app as its provider icon and name when evidence is available", () => {
    hook.page = page(
      [
        shared({
          appAttribution: "agent_time_window",
          appsUsed: ["gmail", "some-custom-api"],
        }),
      ],
      false,
    );
    render(<RunsTab onViewNetwork={vi.fn()} />);
    expect(screen.getByRole("columnheader", { name: "Apps" })).toBeVisible();
    expect(
      screen.getAllByRole("img", { name: "Gmail" }).length,
    ).toBeGreaterThan(0);
    // Unknown providers fall back to the raw id, with no icon.
    expect(screen.getByText("some-custom-api")).toBeInTheDocument();
  });

  it("an empty filter says so in the table", () => {
    hook.page = page([]);
    render(<RunsTab onViewNetwork={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Failed" }));
    expect(screen.getByText("No failed runs.")).toBeInTheDocument();
  });
});
