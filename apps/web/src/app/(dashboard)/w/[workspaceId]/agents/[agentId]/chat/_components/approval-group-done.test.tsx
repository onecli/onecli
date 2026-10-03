// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovalGroupDone } from "./approval-group-done";

const counts = (over: Partial<Record<string, number>> = {}) => ({
  approved: 0,
  denied: 0,
  expired: 0,
  decided: 0,
  ...over,
});

describe("ApprovalGroupDone", () => {
  it("says what the task was and how it ended", () => {
    render(
      <ApprovalGroupDone
        count={39}
        action="Create Contact"
        counts={counts({ approved: 38, denied: 1 })}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "39 × Create Contact· Done: 38 approved, 1 denied",
    );
  });

  it("keeps the shared record as a link after the task is done", () => {
    const url = "https://acme.my.salesforce.com/001fn00000cTWhpAAG";
    render(
      <ApprovalGroupDone
        count={3}
        action="Upload file"
        summary={{
          action: "Upload file to Account Acme",
          details: [],
          subject: {
            verb: "Upload file",
            lead: "Upload file to ",
            record: "Account Acme",
            row: 0,
            url,
          },
        }}
        counts={counts({ denied: 3 })}
      />,
    );
    expect(screen.getByRole("link", { name: /Account Acme/ })).toHaveAttribute(
      "href",
      url,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "3 × Upload file to Account Acme",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Done: 3 denied");
  });
});
