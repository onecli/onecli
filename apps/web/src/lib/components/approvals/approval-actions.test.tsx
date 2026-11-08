// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@onecli/ui/components/tooltip";
import { ApprovalActions } from "./approval-actions";

const mutate = vi.fn();
vi.mock("@/hooks/use-approvals", () => ({
  useDecideApproval: () => ({ mutate, isPending: false, variables: undefined }),
}));

const offer = {
  label: "Attio updates to companies",
  windowMinutes: 15,
  maxRequests: 100,
};

const renderActions = (props: Parameters<typeof ApprovalActions>[0]) =>
  render(
    <TooltipProvider>
      <ApprovalActions {...props} />
    </TooltipProvider>,
  );

describe("ApprovalActions: Approve similar", () => {
  beforeEach(() => mutate.mockReset());

  it("is a plain Approve, with no arrow, unless the gateway offered it", () => {
    renderActions({ approvalId: "ap-1" });
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "More ways to approve" }),
    ).toBeNull();
  });

  it("plain Approve carries no offer even when one exists", async () => {
    renderActions({ approvalId: "ap-1", similar: offer });
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(mutate).toHaveBeenCalledWith(
      { id: "ap-1", decision: "approve" },
      expect.anything(),
    );
  });

  it("the arrow opens Approve similar, which says its bounds and sends the offer", async () => {
    renderActions({
      approvalId: "ap-1",
      agentName: "Sam's bot",
      similar: offer,
    });
    await userEvent.click(
      screen.getByRole("button", { name: "More ways to approve" }),
    );
    const item = screen.getByRole("menuitem", {
      name: /^Approve similar · 15 min/,
    });
    expect(item.textContent).toContain(
      "Also allows up to 100 more Attio updates to companies from Sam's bot.",
    );
    await userEvent.click(item);
    expect(mutate).toHaveBeenCalledWith(
      { id: "ap-1", decision: "approve", similar: offer },
      expect.anything(),
    );
  });

  it("Deny never carries the offer", async () => {
    renderActions({ approvalId: "ap-1", similar: offer });
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(mutate).toHaveBeenCalledWith(
      { id: "ap-1", decision: "deny" },
      expect.anything(),
    );
  });
});
