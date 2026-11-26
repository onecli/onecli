// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@onecli/ui/components/tooltip";
import { ApprovalsBell } from "./approvals-bell";
import { openApprovalsBell } from "./open-approvals-bell";

vi.mock("next/navigation", () => ({ usePathname: () => "/w/ws-1/agents/a" }));
vi.mock("@/lib/navigation", () => ({ hasWorkspaceContext: () => true }));
vi.mock("@/hooks/use-approvals", () => ({
  usePendingApprovals: () => ({ data: [] }),
  usePendingChannelApprovals: () => ({ data: [] }),
}));
// Lost-connection alerts: mutable so a test can put one in the bell.
const alertsState: { data: unknown[] } = { data: [] };
vi.mock("@/hooks/use-channel-alerts", () => ({
  useChannelAlerts: () => alertsState,
}));
vi.mock("./approvals-popover", () => ({
  ApprovalsPopover: () => <div>bell inbox</div>,
}));
vi.mock("./approval-details-dialog", () => ({
  ApprovalDetailsDialog: () => null,
}));

describe("ApprovalsBell", () => {
  it("opens when a page row asks it to", async () => {
    render(
      <TooltipProvider>
        <ApprovalsBell />
      </TooltipProvider>,
    );
    expect(screen.queryByText("bell inbox")).toBeNull();
    await act(async () => openApprovalsBell());
    expect(await screen.findByText("bell inbox")).toBeDefined();
  });

  it("a lost connection counts on the bell even with no approvals, and the label says so", () => {
    alertsState.data = [{ id: "p1" }];
    try {
      render(
        <TooltipProvider>
          <ApprovalsBell />
        </TooltipProvider>,
      );
      expect(screen.getByText("1")).toBeDefined();
      expect(screen.getByText("Pending approvals and alerts")).toBeDefined();
    } finally {
      alertsState.data = [];
    }
  });
});
