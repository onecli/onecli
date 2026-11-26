// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AgentChannelRef } from "@/lib/api/types";

/**
 * The agent header's "reachable on Slack" mark (the old sidebar row showed
 * it too): the provider's logo right after the name once connected, and
 * nothing while the install is still pending.
 */

vi.mock("@/hooks/use-agents", () => ({
  useRenameAgent: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/agents/_components/agent-avatar-editor", () => ({
  AgentAvatarEditor: () => null,
}));

const { AgentHeader } = await import("./agent-header");

const slack = (status?: AgentChannelRef["status"]): AgentChannelRef => ({
  provider: "slack",
  identityName: "dana",
  externalId: "A1",
  ...(status ? { status } : {}),
});

const renderHeader = (channels: AgentChannelRef[]) =>
  render(
    <AgentHeader
      agent={{ id: "ag1", name: "Dana", imageUrl: null, channels }}
    />,
  );

describe("the agent header's connected mark", () => {
  it("shows the Slack logo after the name once connected, and says so to screen readers", () => {
    renderHeader([slack("active")]);
    const button = screen.getByRole("button", {
      name: "Rename Dana, connected to Slack",
    });
    expect(button.querySelector('[title="Connected to Slack"]')).not.toBeNull();
  });

  it("shows nothing while the Slack install is still pending", () => {
    renderHeader([slack("pending_setup")]);
    expect(screen.getByRole("button", { name: "Rename Dana" })).toBeVisible();
    expect(document.querySelector('[title="Connected to Slack"]')).toBeNull();
  });

  it("shows nothing for an agent with no channels", () => {
    renderHeader([]);
    expect(screen.getByRole("button", { name: "Rename Dana" })).toBeVisible();
    expect(document.querySelector('[title^="Connected to"]')).toBeNull();
  });
});
