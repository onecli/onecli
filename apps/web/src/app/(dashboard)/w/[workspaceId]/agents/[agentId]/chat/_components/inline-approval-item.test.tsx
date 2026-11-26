// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PendingApproval } from "@/lib/api/approvals";
import { InlineApprovalItem } from "./inline-approval-item";

vi.mock("@/lib/components/approvals/approval-actions", () => ({
  ApprovalActions: () => <div>actions</div>,
}));

const ID = "003fn00000Fa7bpAAB";
const URL = `https://acme.my.salesforce.com/${ID}`;

const approval = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  id: "ap-1",
  method: "DELETE",
  url: `https://acme.my.salesforce.com/services/data/v60.0/sobjects/Contact/${ID}`,
  host: "acme.my.salesforce.com",
  path: `/services/data/v60.0/sobjects/Contact/${ID}`,
  headers: {},
  bodyPreview: `Delete Contact Dana Reyes\nContact: Dana Reyes (${ID})`,
  agent: { id: "a", name: "Ofer" },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 180_000).toISOString(),
  summary: {
    action: "Delete Contact Dana Reyes",
    details: [{ label: "Contact", value: `Dana Reyes (${ID})`, url: URL }],
    subject: {
      verb: "Delete Contact",
      lead: "Delete Contact ",
      record: "Dana Reyes",
      row: 0,
      url: URL,
    },
  },
  ...over,
});

describe("InlineApprovalItem", () => {
  it("names the record once: in the title, never again as a row or the text preview", () => {
    render(<InlineApprovalItem approval={approval()} />);
    expect(screen.getByRole("link", { name: /Dana Reyes/ })).toHaveAttribute(
      "href",
      URL,
    );
    expect(screen.queryByText(/Contact: Dana Reyes/)).toBeNull();
    expect(screen.queryByText(`Dana Reyes (${ID})`)).toBeNull();
    // With no rows left, the endpoint is the only other hint.
    expect(screen.getByText(/sobjects\/Contact/)).toBeTruthy();
  });

  it("shows the text preview for a legacy row with no structured summary", () => {
    render(
      <InlineApprovalItem
        approval={approval({ summary: undefined, bodyPreview: "POST /v1/x" })}
      />,
    );
    expect(screen.getByText("POST /v1/x")).toBeTruthy();
  });
});
