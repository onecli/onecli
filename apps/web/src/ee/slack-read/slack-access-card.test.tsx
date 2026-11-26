// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PendingActionApprovalItem,
  SlackAccessView,
} from "@/lib/api/channel-approvals";

/**
 * The "act as you in Slack" access card: words from the server summary,
 * Connect for not-connected / reconnect, Allow / Not now otherwise.
 */

const state = vi.hoisted(() => ({
  decide: vi.fn(),
  start: vi.fn(),
  connection: vi.fn(),
}));

vi.mock("@/hooks/use-approvals", () => ({
  useDecideChannelAction: () => ({ mutate: state.decide, isPending: false }),
}));
vi.mock("./hooks", () => ({
  useStartSlackConnect: () => ({ mutate: state.start, isPending: false }),
  // The card re-checks the connection through the hook's own refetch.
  useSlackReadConnection: () => ({
    refetch: async () => ({ data: await state.connection(), isError: false }),
  }),
}));
vi.mock("@/lib/agents/install-popup", () => ({
  openInstallPopup: () => null,
}));

const { SlackAccessCard } = await import("./slack-access-card");

const item = (
  slackAccess: SlackAccessView,
  summary: string,
): PendingActionApprovalItem & { slackAccess: SlackAccessView } => ({
  kind: "action",
  id: "req-1",
  agentId: "donna",
  agentName: "Donna",
  summary,
  standingChoice: false,
  conversationId: "conv",
  createdAt: "2026-10-27T08:00:00Z",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  customConnection: null,
  webhookChange: null,
  slackAccess,
});

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );

describe("SlackAccessCard", () => {
  beforeEach(() => {
    state.decide.mockReset();
    state.start.mockReset();
    state.connection.mockReset();
  });

  it("not connected: the server summary and a Connect Slack button that starts connect", async () => {
    wrap(
      <SlackAccessCard
        item={item(
          { kind: "read", reason: "not_connected", conversationLabel: null },
          "Connect your Slack so Donna can read as you",
        )}
      />,
    );
    expect(
      screen.getByText("Connect your Slack so Donna can read as you"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow read" })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Connect Slack" }),
    );
    expect(state.start).toHaveBeenCalledTimes(1);
    expect(state.decide).not.toHaveBeenCalled();
  });

  it("reconnect for write: a Reconnect Slack button", () => {
    wrap(
      <SlackAccessCard
        item={item(
          {
            kind: "write",
            reason: "reconnect_for_write",
            conversationLabel: "#general",
          },
          "Reconnect your Slack so Donna can write as you",
        )}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Reconnect Slack" }),
    ).toBeTruthy();
  });

  it("not shared: Allow read approves, Not now rejects (after Undo)", async () => {
    const view = wrap(
      <SlackAccessCard
        item={item(
          {
            kind: "read",
            reason: "not_shared",
            conversationLabel: "#weekly-reports",
          },
          "Let Donna read #weekly-reports as you",
        )}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Allow read" }));
    expect(state.decide).toHaveBeenLastCalledWith({
      approvalId: "req-1",
      decision: "approve",
    });
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.getByText("Not sent")).toBeTruthy();
    view.unmount(); // the undo window closes with the card
    expect(state.decide).toHaveBeenLastCalledWith({
      approvalId: "req-1",
      decision: "reject",
    });
    expect(state.start).not.toHaveBeenCalled();
  });

  it("write off: Allow write", () => {
    wrap(
      <SlackAccessCard
        item={item(
          { kind: "write", reason: "write_off", conversationLabel: "#general" },
          "Let Donna write in #general as you?",
        )}
      />,
    );
    expect(screen.getByRole("button", { name: "Allow write" })).toBeTruthy();
  });

  const notConnected = () =>
    item(
      { kind: "read", reason: "not_connected", conversationLabel: null },
      "Connect your Slack so Donna can read as you",
    );

  it("connect card: Not now rejects the request", async () => {
    const view = wrap(<SlackAccessCard item={notConnected()} />);
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    view.unmount();
    expect(state.decide).toHaveBeenLastCalledWith({
      approvalId: "req-1",
      decision: "reject",
    });
  });

  it("after connect, regaining focus re-checks: Connected", async () => {
    state.start.mockImplementation(
      (_: unknown, o: { onSuccess: (r: { authorizeUrl: string }) => void }) =>
        o.onSuccess({ authorizeUrl: "about:blank#x" }),
    );
    state.connection.mockResolvedValue({ connected: true, canWrite: false });
    wrap(<SlackAccessCard item={notConnected()} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Connect Slack" }),
    );
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByText("Connected")).toBeTruthy();
  });

  it("after connect, a popup message with no connection: Didn't connect", async () => {
    state.start.mockImplementation(
      (_: unknown, o: { onSuccess: (r: { authorizeUrl: string }) => void }) =>
        o.onSuccess({ authorizeUrl: "about:blank#x" }),
    );
    state.connection.mockResolvedValue({ connected: false, canWrite: false });
    wrap(<SlackAccessCard item={notConnected()} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Connect Slack" }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: { type: "app-connected", provider: "slack-read" },
      }),
    );
    expect(await screen.findByText("Didn't connect, try again.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
