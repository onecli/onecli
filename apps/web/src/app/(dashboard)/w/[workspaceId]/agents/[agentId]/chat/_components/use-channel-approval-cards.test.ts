import { describe, expect, it } from "vitest";
import type {
  PendingActionApprovalItem,
  PendingReachAskItem,
} from "@/lib/api/channel-approvals";
import { showsInChat } from "./use-channel-approval-cards";

/**
 * The chat must show what the bell shows for this agent: an approval that
 * reached the bell but not the chat is the inconsistency this guards.
 */

const action = (
  overrides: Partial<PendingActionApprovalItem> = {},
): PendingActionApprovalItem => ({
  kind: "action",
  id: "a-1",
  agentId: "ag-1",
  agentName: "Andy",
  summary: "send a message",
  standingChoice: false,
  conversationId: "conv-1",
  createdAt: "2026-11-03T09:00:00.000Z",
  expiresAt: "2026-11-04T09:00:00.000Z",
  customConnection: null,
  webhookChange: null,
  ...overrides,
});

const reach = (
  overrides: Partial<PendingReachAskItem> = {},
): PendingReachAskItem => ({
  kind: "reach",
  id: "r-1",
  agentId: "ag-1",
  agentName: "Andy",
  provider: "slack",
  subjectKind: "external_user",
  subjectLabel: "Dana",
  externalRef: "U123",
  createdAt: "2026-11-03T09:00:00.000Z",
  ...overrides,
});

describe("showsInChat", () => {
  it("shows an action raised in this conversation", () => {
    expect(showsInChat(action(), "ag-1", "conv-1")).toBe(true);
  });

  it("shows an action with no conversation (e.g. a cross-workspace receiver)", () => {
    expect(
      showsInChat(action({ conversationId: null }), "ag-1", "conv-1"),
    ).toBe(true);
  });

  it("shows a reach ask, which belongs to no thread", () => {
    expect(showsInChat(reach(), "ag-1", "conv-1")).toBe(true);
  });

  it("leaves an action from another of the agent's conversations to that thread", () => {
    expect(
      showsInChat(action({ conversationId: "conv-2" }), "ag-1", "conv-1"),
    ).toBe(false);
  });

  it("never shows another agent's approvals", () => {
    expect(showsInChat(action({ agentId: "ag-2" }), "ag-1", "conv-1")).toBe(
      false,
    );
    expect(showsInChat(reach({ agentId: "ag-2" }), "ag-1", "conv-1")).toBe(
      false,
    );
  });
});
