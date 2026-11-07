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

  it("keeps every record-page shape the gateway builds, unchanged", () => {
    // One per gateway template (`summary::record_links`).
    for (const page of [
      "https://github.com/acme/web/issues/42",
      "https://www.notion.so/0123456789abcdef0123456789abcdef",
      "https://trello.com/c/5f1a2b3c4d5e6f7a8b9c0d1e",
      "https://app.todoist.com/app/task/6Xm2Pq9RtV4wZc8K",
      "https://docs.google.com/spreadsheets/d/1SheetId_42/edit",
      "https://drive.google.com/open?id=1AbCdEf98765",
    ]) {
      expect(safeHttpsUrl(page), page).toBe(page);
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
