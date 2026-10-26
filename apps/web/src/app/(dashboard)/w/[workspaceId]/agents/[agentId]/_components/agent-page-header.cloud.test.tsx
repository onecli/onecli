// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentPageAgent } from "./agent-page-frame";

// The edition is read once, when @/lib/env loads; each file pins one. This
// one is the hosted platform: the header carries the Computer button for a
// hosted agent where previews are served.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

const state = vi.hoisted(() => ({
  instance: { previews: {} } as { previews?: object } | null,
  // The button's code arrives later than the header's, the way a lazy
  // chunk does in a browser. Open by default; a test holds it.
  chunk: Promise.resolve(),
}));

// What `app/` code gets from `next/dynamic`: a bare React.lazy that
// suspends to the nearest boundary (the package root never suspends).
vi.mock("next/dynamic", async () => ({
  default: (await import("next/dist/api/app-dynamic")).default,
}));
vi.mock("@/ee/desktop/desktop-header-chip", async () => {
  await state.chunk;
  return {
    DesktopHeaderChip: ({ agentName }: { agentName: string }) => (
      <button>{`${agentName}’s Computer`}</button>
    ),
  };
});
vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/agents/agent-1/skills",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/hooks/use-hosted-availability", () => ({
  useHostedAvailability: () => "ready",
}));
vi.mock("@/hooks/use-instance", () => ({
  useInstance: () => state.instance,
}));
vi.mock("@/lib/agents/_components/agent-avatar-editor", () => ({
  AgentAvatarEditor: () => null,
}));
vi.mock("@/lib/agents/_components/agent-status-pill", () => ({
  AgentStatusPill: () => null,
}));
vi.mock("../../_components/agent-actions-menu", () => ({
  AgentActionsMenu: () => <button>Agent actions</button>,
}));
vi.mock("./agent-details-dialog", () => ({ AgentDetailsDialog: () => null }));

const agent = (kind: AgentPageAgent["kind"]): AgentPageAgent => ({
  id: "agent-1",
  name: "Andy",
  identifier: "andy",
  kind,
  createdAt: "2026-01-01T00:00:00Z",
  channels: [],
  lastSeenAt: null,
});

afterEach(() => {
  state.instance = { previews: {} };
  state.chunk = Promise.resolve();
  vi.resetModules();
});

/** A fresh module, so its lazy button has never loaded (as on a first
 * visit; an earlier test would otherwise have loaded the shared one). */
const freshHeader = async () =>
  (await import("./agent-page-header")).AgentPageHeader;

describe("agent page header on the hosted platform", () => {
  it("shows the Computer button beside the agent menu for a hosted agent", async () => {
    const AgentPageHeader = await freshHeader();
    render(<AgentPageHeader agent={agent("hosted")} />);
    const chip = await screen.findByRole("button", { name: "Andy’s Computer" });
    expect(chip.nextElementSibling).toBe(
      screen.getByRole("button", { name: "Agent actions" }),
    );
  });

  it("keeps the header on screen while the button's code loads", async () => {
    let arrive!: () => void;
    state.chunk = new Promise<void>((resolve) => (arrive = resolve));
    const AgentPageHeader = await freshHeader();
    render(
      // The route's loading.tsx boundary, as Next mounts it.
      <Suspense fallback={<p>Loading the agent section</p>}>
        <AgentPageHeader agent={agent("hosted")} />
      </Suspense>,
    );
    expect(screen.queryByText("Loading the agent section")).toBeNull();
    expect(screen.getByRole("heading", { name: "Andy" })).toBeVisible();
    await act(async () => {
      arrive();
      await state.chunk;
    });
    expect(
      await screen.findByRole("button", { name: "Andy’s Computer" }),
    ).toBeVisible();
  });

  it("has no Computer button for an agent that isn't hosted", async () => {
    const AgentPageHeader = await freshHeader();
    render(<AgentPageHeader agent={agent("byo")} />);
    expect(
      screen.queryByRole("button", { name: "Andy’s Computer" }),
    ).toBeNull();
  });

  it("has no Computer button where previews aren't served", async () => {
    state.instance = {};
    const AgentPageHeader = await freshHeader();
    render(<AgentPageHeader agent={agent("hosted")} />);
    expect(
      screen.queryByRole("button", { name: "Andy’s Computer" }),
    ).toBeNull();
  });
});
