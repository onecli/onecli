// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovalLink, safeHttpsUrl } from "./approval-link";

const RECORD = "https://acme.my.salesforce.com/001xx000003DGb2AAG";

describe("safeHttpsUrl", () => {
  it("keeps only absolute https URLs", () => {
    expect(safeHttpsUrl(RECORD)).toBe(RECORD);
    for (const bad of [
      undefined,
      "",
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "http://acme.my.salesforce.com/x",
      "//evil.test/x",
      "/relative",
    ]) {
      expect(safeHttpsUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe("ApprovalLink", () => {
  it("renders a record as a new-tab link", () => {
    render(<ApprovalLink href={RECORD}>Acme Account</ApprovalLink>);
    const link = screen.getByRole("link", { name: /Acme Account/ });
    expect(link).toHaveAttribute("href", RECORD);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders plain text without a url, or with an unsafe one", () => {
    const { rerender } = render(
      <ApprovalLink href={undefined}>QA Lead</ApprovalLink>,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("QA Lead")).toBeInTheDocument();
    rerender(<ApprovalLink href="javascript:alert(1)">X</ApprovalLink>);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
