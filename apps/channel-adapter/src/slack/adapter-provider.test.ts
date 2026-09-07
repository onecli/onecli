import { describe, expect, it, vi } from "vitest";
import type { AdapterPresence } from "@onecli/agent-protocol";
import type { ProviderTransportHandlers } from "../providers";

/**
 * The socket arm's interactivity CLASSIFICATION boundary: a raw Slack
 * block_actions payload arriving on the live socket must route to the right
 * handler — approval clicks to `onApprovalDecision`, reach-card clicks to
 * `onReachDecision`, everything else to neither. This is the seam the
 * orchestrator trusts (adapter.ts forwards whatever the provider classified),
 * so a mis-route here silently drops or cross-wires human decisions.
 *
 * `openSocketMode` is mocked to capture the handlers openTransport installs;
 * the test then feeds payloads straight into `onInteractive` — the exact
 * shape socket-mode.ts delivers (it hands the envelope's payload through
 * untouched, proven by its own suite).
 */

const socketMock = vi.hoisted(() => ({
  onInteractive: undefined as
    | ((payload: Record<string, unknown>) => void)
    | undefined,
}));

vi.mock("./socket-mode", () => ({
  openSocketMode: (
    _options: unknown,
    handlers: { onInteractive: (payload: Record<string, unknown>) => void },
  ) => {
    socketMock.onInteractive = handlers.onInteractive;
    return { close: () => {}, isOpen: () => true };
  },
}));

import { slackAdapterProvider } from "./adapter-provider";

const presence: AdapterPresence = {
  presenceId: "pr-1",
  provider: "slack",
  transport: "socket",
  credentialsJson: JSON.stringify({ appToken: "xapp-1", botToken: "xoxb-1" }),
  agent: { id: "ag-1", name: "reachy" },
  iconUrl: null,
  serviceKey: null,
  appMode: "regular",
  identityRef: "UBOT",
  links: [],
} as unknown as AdapterPresence;

const openWithSpies = () => {
  const approvals: unknown[] = [];
  const reaches: unknown[] = [];
  const handlers: ProviderTransportHandlers = {
    onEvent: () => {},
    onApprovalDecision: (d) => approvals.push(d),
    onReachDecision: (d) => reaches.push(d),
    onPermanentFailure: () => {},
    onLog: () => {},
  };
  const transport = slackAdapterProvider.openTransport(presence, handlers);
  expect(transport).not.toBeNull();
  if (!socketMock.onInteractive) throw new Error("socket never dialed");
  return { approvals, reaches, deliver: socketMock.onInteractive };
};

describe("slack adapter-provider — interactivity classification", () => {
  it("routes a reach-card click to onReachDecision with only the opaque grant id", () => {
    const { approvals, reaches, deliver } = openWithSpies();
    deliver({
      type: "block_actions",
      user: { id: "U-CLICKER" },
      actions: [{ action_id: "reach_approve", value: "grant-123" }],
    });
    expect(reaches).toEqual([
      {
        grantId: "grant-123",
        decision: "approved",
        clickerExternalUserId: "U-CLICKER",
      },
    ]);
    expect(approvals).toEqual([]);
  });

  it("routes the members-only button as members_only", () => {
    const { reaches, deliver } = openWithSpies();
    deliver({
      type: "block_actions",
      user: { id: "U-CLICKER" },
      actions: [{ action_id: "reach_members", value: "grant-9" }],
    });
    expect(reaches).toEqual([
      {
        grantId: "grant-9",
        decision: "members_only",
        clickerExternalUserId: "U-CLICKER",
      },
    ]);
  });

  it("routes the block button as blocked - the third settlement", () => {
    const { reaches, deliver } = openWithSpies();
    deliver({
      type: "block_actions",
      user: { id: "U-CLICKER" },
      actions: [{ action_id: "reach_block", value: "grant-7" }],
    });
    expect(reaches).toEqual([
      {
        grantId: "grant-7",
        decision: "blocked",
        clickerExternalUserId: "U-CLICKER",
      },
    ]);
  });

  it("still honors the PRE-RENAME reach_deny id: a card posted before the third button existed settles as members_only", () => {
    const { reaches, deliver } = openWithSpies();
    deliver({
      type: "block_actions",
      user: { id: "U-CLICKER" },
      actions: [{ action_id: "reach_deny", value: "grant-old" }],
    });
    expect(reaches).toEqual([
      {
        grantId: "grant-old",
        decision: "members_only",
        clickerExternalUserId: "U-CLICKER",
      },
    ]);
  });

  it("keeps approval clicks on the approval path — never cross-wired", () => {
    const { approvals, reaches, deliver } = openWithSpies();
    deliver({
      type: "block_actions",
      user: { id: "U-CLICKER" },
      actions: [{ action_id: "channel_approve", value: "appr-1" }],
    });
    expect(approvals).toEqual([
      {
        approvalId: "appr-1",
        decision: "approve",
        clickerExternalUserId: "U-CLICKER",
      },
    ]);
    expect(reaches).toEqual([]);
  });

  it("drops foreign block_actions (another surface's button) on the floor", () => {
    const { approvals, reaches, deliver } = openWithSpies();
    deliver({
      type: "block_actions",
      user: { id: "U-CLICKER" },
      actions: [{ action_id: "some_other_button", value: "x" }],
    });
    deliver({ type: "view_submission" });
    deliver({
      type: "block_actions",
      // No clicker: the control plane could not authorize anyone — drop.
      actions: [{ action_id: "reach_approve", value: "grant-1" }],
    });
    expect(approvals).toEqual([]);
    expect(reaches).toEqual([]);
  });
});
