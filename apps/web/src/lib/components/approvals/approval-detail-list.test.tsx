// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovalDetailList, isLongValue } from "./approval-detail-list";

const POEM =
  "Roses are red, deploys are green,\nApprovals flow through the gateway machine.";

describe("ApprovalDetailList", () => {
  it("treats multi-line or long values as prose", () => {
    expect(isLongValue("sam@example.com")).toBe(false);
    expect(isLongValue("a\nb")).toBe(true);
    expect(isLongValue("x".repeat(81))).toBe(true);
  });

  it("keeps short values inline and puts prose in its own block", () => {
    const { container } = render(
      <ApprovalDetailList
        details={[
          { label: "To", value: "sam@example.com" },
          { label: "Body", value: POEM },
        ]}
      />,
    );
    // Inline label keeps its colon; the block label stands alone.
    expect(screen.getByText("To:")).toBeTruthy();
    expect(screen.getByText("Body")).toBeTruthy();
    // Line breaks survive, so a poem reads as a poem.
    const body = container.querySelector(".whitespace-pre-wrap");
    expect(body?.textContent).toBe(POEM);
  });
});
