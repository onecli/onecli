// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { groupApprovals } from "@onecli/api/lib/approval-groups";
import type { PendingApproval } from "@/lib/api/approvals";

const mutate = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-approvals", () => ({
  useDecideApprovals: () => ({ mutate, isPending: false }),
}));
vi.mock("@/lib/components/approvals/approval-details-dialog", () => ({
  ApprovalDetailsDialog: () => null,
}));

const { ApprovalGroupStack } = await import("./approval-group-stack");

let n = 0;
const request = (action: string, name: string): PendingApproval => {
  n += 1;
  return {
    id: `ap-${n}`,
    method: "POST",
    url: "https://x.test/",
    host: "x.test",
    path: "/",
    headers: {},
    app: "salesforce",
    agent: { id: "ofer", name: "Ofer" },
    summary: { action, details: [{ label: "Name", value: name }] },
    createdAt: new Date(Date.now() + n).toISOString(),
    expiresAt: new Date(Date.now() + 180_000).toISOString(),
  };
};

describe("ApprovalGroupStack", () => {
  it("shows parallel tasks as ONE card with a section each, each deciding only its own rows", () => {
    const creates = [
      request("Create Contact", "Ben"),
      request("Create Contact", "Gal"),
    ];
    const updates = [
      request("Update Contact", "Mor"),
      request("Update Contact", "Ron"),
    ];
    const groups = groupApprovals([...creates, ...updates]).map((group) => ({
      key: group.key,
      group,
      settled: [],
    }));
    render(<ApprovalGroupStack groups={groups} />);

    expect(screen.getByText("4 approvals · 2 tasks")).toBeInTheDocument();
    expect(screen.getAllByRole("group")).toHaveLength(2);
    fireEvent.click(screen.getAllByText(/^Approve all 2$/)[1]!);
    expect(mutate).toHaveBeenLastCalledWith({
      ids: updates.map((u) => u.id),
      decision: "approve",
    });
  });
});
