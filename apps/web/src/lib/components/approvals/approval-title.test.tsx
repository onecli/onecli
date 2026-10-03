// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovalTitle } from "./approval-title";

const subject = {
  verb: "Upload file",
  lead: "Upload file to ",
  record: "Account OneCLI Demo Acme Robotics",
  row: 1,
  url: "https://acme.my.salesforce.com/001fn00000cTWhpAAG",
};

describe("ApprovalTitle", () => {
  it("makes the record the link in the title", () => {
    render(
      <ApprovalTitle
        summary={{ action: "x", details: [], subject }}
        fallback="POST request"
      />,
    );
    const link = screen.getByRole("link", {
      name: /Account OneCLI Demo Acme Robotics/,
    });
    expect(link).toHaveAttribute("href", subject.url);
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(document.body.textContent).toContain("Upload file to");
  });

  it("never links anything but https", () => {
    render(
      <ApprovalTitle
        summary={{
          action: "x",
          details: [],
          subject: { ...subject, url: "javascript:alert(1)" },
        }}
        fallback="POST request"
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.body.textContent).toBe(
      "Upload file to Account OneCLI Demo Acme Robotics",
    );
  });

  it("falls back to the plain action, then to the method", () => {
    const { rerender } = render(
      <ApprovalTitle
        summary={{ action: "Send email", details: [] }}
        fallback="POST request"
      />,
    );
    expect(document.body.textContent).toBe("Send email");
    rerender(<ApprovalTitle summary={null} fallback="POST request" />);
    expect(document.body.textContent).toBe("POST request");
  });
});
