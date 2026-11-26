// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PendingApproval } from "@/lib/api/approvals";
import { ApprovalListItem } from "./approval-list-item";

vi.mock("./approval-actions", () => ({
  ApprovalActions: () => <div>actions</div>,
}));

const approval = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  id: "ap-1",
  method: "POST",
  url: "https://acme.my.salesforce.com/services/data/v60.0/sobjects/Contact",
  host: "acme.my.salesforce.com",
  path: "/services/data/v60.0/sobjects/Contact",
  headers: {},
  agent: { id: "a", name: "Ofer" },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 180_000).toISOString(),
  summary: {
    action: "Create Contact",
    details: [
      { label: "First name", value: "Test" },
      { label: "Last name", value: "Approval Card" },
      { label: "Email", value: "test.card@example.com" },
      { label: "Title", value: "QA Lead" },
    ],
  },
  ...over,
});

describe("ApprovalListItem (bell)", () => {
  it("stays compact: agent, first two fields, and a count of the rest", () => {
    render(<ApprovalListItem approval={approval()} onShowDetails={() => {}} />);
    const line = screen.getByText(/Ofer/);
    expect(line.textContent).toBe("Ofer · Test · Approval Card · +2 more");
    expect(screen.queryByText(/test\.card@example\.com/)).toBeNull();
    expect(screen.queryByText(/sobjects/)).toBeNull();
  });

  it("shows the app's logo when the request is for a catalog app", () => {
    render(
      <ApprovalListItem
        approval={approval({ app: "salesforce" })}
        onShowDetails={() => {}}
      />,
    );
    expect(screen.getByAltText("Salesforce")).toBeTruthy();
  });

  it("falls back to the approval shield for an unknown host", () => {
    render(
      <ApprovalListItem
        approval={approval({ app: "not-an-app" })}
        onShowDetails={() => {}}
      />,
    );
    expect(screen.queryByRole("img")).toBeNull();
  });
});
