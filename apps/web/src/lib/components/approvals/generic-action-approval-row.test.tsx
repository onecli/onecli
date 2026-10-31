// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PendingActionApprovalItem } from "@/lib/api/channel-approvals";
import { GenericActionApprovalRow } from "./generic-action-approval-row";

const mutate = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-approvals", () => ({
  useDecideChannelAction: () => ({ mutate }),
}));

const item: PendingActionApprovalItem = {
  kind: "action",
  id: "ap-1",
  agentId: "a-1",
  agentName: "Donna",
  summary: "create webhook deploy-hook",
  standingChoice: false,
  conversationId: null,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  customConnection: null,
  webhookChange: null,
};

afterEach(() => mutate.mockClear());

describe("GenericActionApprovalRow: a one-off action", () => {
  it("Reject rejects in one click, with no reason prompt", async () => {
    render(<GenericActionApprovalRow item={item} />);
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(mutate).toHaveBeenCalledWith({
      approvalId: "ap-1",
      decision: "reject",
      standing: false,
    });
    expect(screen.queryByText("Reject this request?")).toBeNull();
  });

  it("Details still offers a reject with a reason, which reaches the agent", async () => {
    render(<GenericActionApprovalRow item={item} />);
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Reject with a reason…" }),
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "Rejection reason" }),
      "ask me first",
    );
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(mutate).toHaveBeenCalledWith({
      approvalId: "ap-1",
      decision: "reject",
      standing: false,
      reason: "ask me first",
    });
  });
});
