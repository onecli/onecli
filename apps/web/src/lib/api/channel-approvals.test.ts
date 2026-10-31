import { describe, expect, it } from "vitest";
import {
  bellChannelApprovals,
  type PendingActionApprovalItem,
  type SlackAccessView,
} from "./channel-approvals";

const action = (
  id: string,
  slackAccess: SlackAccessView | null,
): PendingActionApprovalItem => ({
  kind: "action",
  id,
  agentId: "a",
  agentName: "Donna",
  summary: "s",
  standingChoice: false,
  conversationId: "c",
  createdAt: "2026-10-27T08:00:00Z",
  expiresAt: "2026-10-28T08:00:00Z",
  customConnection: null,
  webhookChange: null,
  slackAccess,
});

describe("bellChannelApprovals", () => {
  it("drops Slack connect cards (chat only), keeps everything else", () => {
    const items = [
      action("connect", {
        kind: "read",
        reason: "not_connected",
        conversationLabel: null,
      }),
      action("reconnect", {
        kind: "write",
        reason: "reconnect_for_write",
        conversationLabel: null,
      }),
      action("share", {
        kind: "read",
        reason: "not_shared",
        conversationLabel: "#x",
      }),
      action("plain", null),
    ];
    expect(bellChannelApprovals(items).map((i) => i.id)).toEqual([
      "share",
      "plain",
    ]);
  });
});
