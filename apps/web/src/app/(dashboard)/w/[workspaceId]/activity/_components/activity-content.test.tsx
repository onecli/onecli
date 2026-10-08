// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { RunListItem } from "@/lib/api/runs";
import type { NetworkScope } from "./network-tab";

/**
 * Activity's shell: the tab, the agent and a run's window live in the URL,
 * so an agent's "View activity" and a run's "View requests in Network" land
 * on the right view. The tabs themselves are stubbed: this pins the routing
 * contract. URL changes go through the History API (no server round-trip);
 * a run's Network view is a new history entry, so Back returns to Runs.
 */
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws/activity",
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("@/hooks/use-agents", () => ({
  useAgents: () => ({ data: [{ id: "ag-1", name: "Donna" }] }),
}));
vi.mock("@dashboard/page-header", () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
const tabs = vi.hoisted(() => ({
  runs: null as null | {
    agentId?: string;
    onViewNetwork: (run: RunListItem) => void;
  },
  network: null as null | { scope: NetworkScope; onClearWindow: () => void },
}));
vi.mock("./runs-tab", () => ({
  RunsTab: (props: NonNullable<typeof tabs.runs>) => {
    tabs.runs = props;
    return <div>runs tab</div>;
  },
}));
vi.mock("./network-tab", () => ({
  NetworkTab: (props: NonNullable<typeof tabs.network>) => {
    tabs.network = props;
    return <div>network tab</div>;
  },
}));

const { ActivityContent } = await import("./activity-content");

const run: RunListItem = {
  turnId: "t1",
  conversationId: "c1",
  agent: { id: "ag-1", name: "Donna" },
  source: "cron",
  direct: false,
  status: "done",
  askedBy: null,
  appAttribution: "withheld",
  appsUsed: [],
  createdAt: "2026-09-01T10:00:00.000Z",
  startedAt: "2026-09-01T10:00:00.000Z",
  finishedAt: "2026-09-01T10:00:30.000Z",
  durationMs: 30_000,
  private: false,
  question: "q",
  answer: null,
  error: null,
  toolNames: [],
};

const lastUrl = (spy: ReturnType<typeof vi.spyOn>) => {
  const url = new URL(String(spy.mock.calls.at(-1)?.[2]), "http://x");
  return { path: url.pathname, query: Object.fromEntries(url.searchParams) };
};

let push: ReturnType<typeof vi.spyOn>;
let replace: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  nav.search = "";
  tabs.runs = null;
  tabs.network = null;
  push = vi.spyOn(window.history, "pushState");
  replace = vi.spyOn(window.history, "replaceState");
});
afterEach(() => {
  push.mockRestore();
  replace.mockRestore();
});

describe("Activity tabs", () => {
  it("opens on Network by default, across all agents", () => {
    render(<ActivityContent />);
    expect(screen.getByText("network tab")).toBeInTheDocument();
    expect(tabs.network?.scope).toEqual({});
  });

  it("Runs is the second tab, opened with ?tab=runs and narrowed by agent", () => {
    nav.search = "tab=runs&agent=ag-1";
    render(<ActivityContent />);
    expect(screen.getByText("runs tab")).toBeInTheDocument();
    expect(tabs.runs?.agentId).toBe("ag-1");
    const network = screen.getByRole("button", { name: "Network" });
    const runs = screen.getByRole("button", { name: "Runs" });
    expect(
      network.compareDocumentPosition(runs) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("switching tab keeps the agent, drops a run's window, and replaces history", () => {
    nav.search =
      "agent=ag-1&from=2026-09-01T10:00:00.000Z&to=2026-09-01T10:01:00.000Z";
    render(<ActivityContent />);
    fireEvent.click(screen.getByRole("button", { name: "Runs" }));
    expect(push).not.toHaveBeenCalled();
    expect(lastUrl(replace)).toEqual({
      path: "/w/ws/activity",
      query: { tab: "runs", agent: "ag-1" },
    });
  });

  it("passes a valid agent and window to Network as its scope", () => {
    nav.search =
      "agent=ag-1&from=2026-09-01T10:00:00.000Z&to=2026-09-01T10:01:00.000Z";
    render(<ActivityContent />);
    expect(tabs.network?.scope).toEqual({
      agentId: "ag-1",
      from: "2026-09-01T10:00:00.000Z",
      to: "2026-09-01T10:01:00.000Z",
    });
  });

  it("drops a malformed scope from a hand-edited URL instead of querying it", () => {
    nav.search = "agent=ag-1&from=yesterday";
    render(<ActivityContent />);
    expect(tabs.network?.scope).toEqual({});
  });

  it("clearing the window keeps the agent", () => {
    nav.search = "agent=ag-1&from=2026-09-01T10:00:00.000Z";
    render(<ActivityContent />);
    tabs.network?.onClearWindow();
    expect(lastUrl(replace).query).toEqual({ agent: "ag-1" });
  });

  it("a run's View requests in Network pushes Network, narrowed to its agent and padded window", () => {
    nav.search = "tab=runs";
    render(<ActivityContent />);
    tabs.runs?.onViewNetwork(run);
    expect(replace).not.toHaveBeenCalled();
    expect(lastUrl(push)).toEqual({
      path: "/w/ws/activity",
      query: {
        agent: "ag-1",
        from: "2026-09-01T09:59:58.000Z",
        to: "2026-09-01T10:00:32.000Z",
      },
    });
  });

  it("an unfinished run opens an open-ended window", () => {
    nav.search = "tab=runs";
    render(<ActivityContent />);
    tabs.runs?.onViewNetwork({ ...run, finishedAt: null });
    expect(lastUrl(push).query).toEqual({
      agent: "ag-1",
      from: "2026-09-01T09:59:58.000Z",
    });
  });
});
