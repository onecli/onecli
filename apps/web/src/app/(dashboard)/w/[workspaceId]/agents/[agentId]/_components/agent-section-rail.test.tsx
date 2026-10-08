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

const nav: { pathname: string } = { pathname: "/w/p1/agents/ag-1/chat" };
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
}));

vi.mock("@/hooks/use-counts", () => ({
  useCounts: () => ({ data: undefined }),
}));

// The rail reads the instance for the SSH auto-hide gate. Mutable so the
// gate tests below can flip it; the default is an
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
  nav.pathname = "/w/p1/agents/ag-1/chat";
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
 * Advanced is a drill-in, like a workspace from All workspaces: the main view
 * shows ONE Advanced row; an advanced section's URL shows a back link plus
 * the advanced sections. SSH is instance-gated: hidden once /v1/instance
 * resolves without it, shown while loading (loading must never render as
 * unavailable).
 */
describe("the rail's Advanced drill-in", () => {
  const ADVANCED_URL = "/w/p1/agents/ag-1/ssh";

  it("shows one Advanced row (not its sections) in the main view", () => {
    render(<AgentSectionRail agent={agentWith([])} />);
    const rows = screen.getAllByRole("link", { name: "Advanced" });
    // Desktop aside + mobile strip.
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toHaveAttribute("href", ADVANCED_URL);
    expect(screen.queryByText("SSH")).not.toBeInTheDocument();
    expect(screen.queryByText("Back to agent")).not.toBeInTheDocument();
  });

  it("swaps to the Advanced menu with a back link on an advanced URL", () => {
    nav.pathname = ADVANCED_URL;
    render(<AgentSectionRail agent={agentWith([])} />);
    for (const back of screen.getAllByRole("link", { name: "Back to agent" }))
      expect(back).toHaveAttribute("href", "/w/p1/agents/ag-1/chat");
    expect(screen.getAllByText("SSH")).toHaveLength(2);
    // The open section is marked, under the group table's heading, and the
    // drill-in row is gone: this view is already inside Advanced.
    for (const ssh of screen.getAllByRole("link", { name: "SSH" }))
      expect(ssh).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Advanced")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Advanced" }),
    ).not.toBeInTheDocument();
    // The everyday sections are gone from this view.
    expect(screen.queryByText("Models")).not.toBeInTheDocument();
    expect(screen.queryByText("Chat")).not.toBeInTheDocument();
  });

  it("keeps a BYO agent on the main view with no Advanced row, even on an advanced URL", () => {
    // A BYO agent has no advanced section, so a hand-typed /ssh (the frame
    // shows its hosted-only notice) must not open an empty drill-in.
    nav.pathname = ADVANCED_URL;
    render(<AgentSectionRail agent={{ ...agentWith([]), kind: "byo" }} />);
    expect(
      screen.queryByRole("link", { name: "Advanced" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Back to agent")).not.toBeInTheDocument();
    expect(screen.getAllByText("Connections").length).toBeGreaterThan(0);
  });

  it("keeps the Advanced row while the instance is still loading", () => {
    instanceState.value = null;
    render(<AgentSectionRail agent={agentWith([])} />);
    expect(screen.getAllByRole("link", { name: "Advanced" })).toHaveLength(2);
  });

  it("points the Advanced row past SSH once the instance resolves without it", () => {
    instanceState.value = { ...instanceWithSsh(), ssh: undefined };
    render(<AgentSectionRail agent={agentWith([])} />);
    for (const row of screen.getAllByRole("link", { name: "Advanced" }))
      expect(row).toHaveAttribute("href", "/w/p1/agents/ag-1/webhooks");
    // The rest of the rail stays.
    expect(screen.getAllByText("Models").length).toBeGreaterThan(0);
  });
});
