// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PendingActionApprovalItem } from "@/lib/api/channel-approvals";

/**
 * The agent wants to message someone with no setting yet: the bell asks
 * ONCE about the person, in the Contacts words (Always allow / Never),
 * never a per-message Approve / Reject.
 */

const decide = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-approvals", () => ({
  useDecideChannelAction: () => ({ mutate: decide, isPending: false }),
}));

import { GenericActionApprovalRow } from "./generic-action-approval-row";

const item = (
  overrides: Partial<PendingActionApprovalItem> = {},
): PendingActionApprovalItem => ({
  kind: "action",
  id: "ap-1",
  agentId: "ag-1",
  agentName: "Donna",
  summary: 'message Sam from now on? First message: "hi"',
  standingChoice: true,
  conversationId: null,
  createdAt: "2026-10-21T10:00:00Z",
  expiresAt: "2026-10-22T10:00:00Z",
  customConnection: null,
  webhookChange: null,
  ...overrides,
});

describe("a standing question in the bell", () => {
  it("offers only Always allow and Never, and each sends the standing answer", async () => {
    render(<GenericActionApprovalRow item={item()} />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Always allow" }));
    expect(decide).toHaveBeenLastCalledWith({
      approvalId: "ap-1",
      decision: "approve",
      standing: true,
    });
    await userEvent.click(screen.getByRole("button", { name: "Never" }));
    expect(decide).toHaveBeenLastCalledWith({
      approvalId: "ap-1",
      decision: "reject",
      standing: true,
    });
  });

  it("a one-off action (no standing question) keeps Approve / Reject", () => {
    render(<GenericActionApprovalRow item={item({ standingChoice: false })} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Never" })).toBeNull();
  });
});
