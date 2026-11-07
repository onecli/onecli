// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentPageAgent } from "./agent-page-frame";

// A self-host never shows the agent's hosted computer in the header, even for
// a hosted agent where previews are served, and the licensed button is never
// loaded. The edition is read once, when @/lib/env loads, so it is cleared
// before anything imports it.
vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_EDITION;
});

const loaded = vi.hoisted(() => ({ chip: false }));

vi.mock("@/ee/desktop/desktop-header-chip", () => {
  loaded.chip = true;
  return { DesktopHeaderChip: () => <button>Andy’s Computer</button> };
});
vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/agents/agent-1/chat",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/hooks/use-hosted-availability", () => ({
  useHostedAvailability: () => "ready",
}));
vi.mock("@/hooks/use-instance", () => ({
  useInstance: () => ({ previews: {} }),
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

const { AgentPageHeader } = await import("./agent-page-header");

const hosted: AgentPageAgent = {
  id: "agent-1",
  name: "Andy",
  identifier: "andy",
  kind: "hosted",
  createdAt: "2026-01-01T00:00:00Z",
  channels: [],
  lastSeenAt: null,
};

describe("agent page header on a self-host", () => {
  it("has no Computer button and never loads the licensed button", () => {
    render(<AgentPageHeader agent={hosted} />);
    expect(screen.getByRole("button", { name: "Agent actions" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Andy’s Computer" }),
    ).toBeNull();
    expect(loaded.chip).toBe(false);
  });
});
