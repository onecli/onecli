// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SlackReadAgent } from "./api";

const state = vi.hoisted(() => ({
  agents: [] as SlackReadAgent[],
  pending: false,
}));

vi.mock("./hooks", () => ({
  useSlackReadAgents: () => ({
    data: state.pending ? undefined : { agents: state.agents },
    isPending: state.pending,
    isError: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/connections",
}));

const { SlackReadTile } = await import("./slack-read-tile");

const agent = (over: Partial<SlackReadAgent> = {}): SlackReadAgent => ({
  agentId: "ag-1",
  agentName: "Helper",
  imageUrl: null,
  handle: "helper",
  connected: false,
  sharedByMe: 0,
  available: true,
  ...over,
});

describe("SlackReadTile", () => {
  beforeEach(() => {
    state.agents = [];
    state.pending = false;
  });

  it("opens the finder: each Slack agent with your standing, linking to its Slack page", async () => {
    state.agents = [
      agent(),
      agent({
        agentId: "ag-2",
        agentName: "Deploy Agent",
        handle: "deploy-agent",
        connected: true,
        sharedByMe: 3,
      }),
      agent({
        agentId: "ag-3",
        agentName: "Donna",
        handle: null,
        available: false,
      }),
    ];
    render(<SlackReadTile />);
    await userEvent.click(screen.getByRole("button", { name: /Slack/ }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Let an agent read your Slack"),
    ).toBeTruthy();

    const helper = within(dialog).getByRole("link", { name: /Helper/ });
    expect(helper.getAttribute("href")).toBe("/w/ws-1/agents/ag-1/channels");
    expect(within(helper).getByText("Connect")).toBeTruthy();
    expect(within(helper).getByText("@helper in Slack")).toBeTruthy();

    const deployAgent = within(dialog).getByRole("link", {
      name: /Deploy Agent/,
    });
    expect(within(deployAgent).getByText("3 shared")).toBeTruthy();

    const donna = within(dialog).getByRole("link", { name: /Donna/ });
    expect(within(donna).getByText("Needs setup")).toBeTruthy();
  });

  it("no Slack agent yet: says how to get one", async () => {
    render(<SlackReadTile />);
    await userEvent.click(screen.getByRole("button", { name: /Slack/ }));
    expect(await screen.findByText(/No agent here has Slack yet/)).toBeTruthy();
  });
});
