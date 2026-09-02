// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { InstanceInfo } from "@/lib/api/types";
import type { AgentPageAgent } from "./agent-page-frame";

/**
 * The rail's connected mark (PR #845): the channels row — and ONLY the
 * channels row — swaps its grey glyph for the colorful Slack mark, and only
 * once an install actually completed. A `pending_setup` presence (clicked
 * but unfinished) keeps the plain glyph, matching the Channels section's own
 * attached test.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/p1/agents/ag-1/chat",
}));

vi.mock("@/hooks/use-counts", () => ({
  useCounts: () => ({ data: undefined }),
}));

// The rail reads the instance for the SSH auto-hide gate (sandbox-platform
// step 5). Mutable so the gate tests below can flip it; the default is an
// instance WITH ssh, so the gated entry renders like any other row.
const instanceState: { value: InstanceInfo | null } = { value: null };
const instanceWithSsh = (): InstanceInfo => ({
  edition: "cloud",
  entitled: true,
  version: "0.0.0-test",
  ssh: { host: "ssh.onecli.test" },
});
beforeEach(() => {
  instanceState.value = instanceWithSsh();
});

vi.mock("@/hooks/use-instance", () => ({
  useInstance: () => instanceState.value,
}));

// Structural chrome (AppIcon renders through next/image).
vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: unknown; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={typeof src === "string" ? src : ""} alt={alt ?? ""} />
  ),
}));

const { AgentSectionRail } = await import("./agent-section-rail");

const agentWith = (channels: AgentPageAgent["channels"]): AgentPageAgent => ({
  id: "ag-1",
  name: "Donna",
  identifier: "donna",
  accessToken: "tok",
  kind: "hosted",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  channels,
  imageUrl: null,
  lastSeenAt: null,
  workingInBackground: false,
});

const slackChannel = (status: string) => ({
  provider: "slack",
  identityName: "donna",
  externalId: "A123",
  settingsUrl: null,
  status,
});

describe("the rail's Slack connected mark", () => {
  it("marks the channels row — and only it — when the install completed", () => {
    render(<AgentSectionRail agent={agentWith([slackChannel("active")])} />);

    // The rail renders twice (desktop aside + mobile strip) — both marked.
    const marks = screen.getAllByText("(connected to Slack)");
    expect(marks).toHaveLength(2);
    for (const mark of marks) {
      expect(mark.closest("a")).toHaveAttribute(
        "href",
        "/w/p1/agents/ag-1/channels",
      );
    }
  });

  it("keeps the grey glyph for a pending_setup presence — existence is not connection", () => {
    render(
      <AgentSectionRail agent={agentWith([slackChannel("pending_setup")])} />,
    );
    expect(screen.queryByText("(connected to Slack)")).not.toBeInTheDocument();
  });

  it("shows no mark when no Slack presence exists", () => {
    render(<AgentSectionRail agent={agentWith([])} />);
    expect(screen.queryByText("(connected to Slack)")).not.toBeInTheDocument();
  });
});

/**
 * The SSH auto-hide gate (sandbox-platform step 5): an instance-gated entry
 * exists only where the deployment has the capability. Loading shows the
 * entry — loading must never render as unavailable (the availability.ts law).
 */
describe("the rail's SSH instance gate", () => {
  it("shows the SSH entry when the instance has ssh", () => {
    render(<AgentSectionRail agent={agentWith([])} />);
    // Desktop aside + mobile strip.
    expect(screen.getAllByText("SSH")).toHaveLength(2);
  });

  it("shows the SSH entry while the instance is still loading", () => {
    instanceState.value = null;
    render(<AgentSectionRail agent={agentWith([])} />);
    expect(screen.getAllByText("SSH")).toHaveLength(2);
  });

  it("hides the SSH entry once the instance resolves without ssh", () => {
    instanceState.value = { ...instanceWithSsh(), ssh: undefined };
    render(<AgentSectionRail agent={agentWith([])} />);
    expect(screen.queryByText("SSH")).not.toBeInTheDocument();
    // Only the gated entry disappears — the rest of Access stays.
    expect(screen.getAllByText("Models").length).toBeGreaterThan(0);
  });
});
