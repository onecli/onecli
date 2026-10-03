// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovalPreview } from "./approval-preview";

const POEM = "Roses are red, deploys are green,\nApprovals flow.";

describe("ApprovalPreview", () => {
  it("draws an email as a message: headers, bold subject, body with line breaks", () => {
    const { container } = render(
      <ApprovalPreview
        kind="email"
        details={[
          { label: "To", value: "sam@example.com" },
          { label: "Subject", value: "A little poem for you" },
          { label: "Body", value: POEM },
        ]}
      />,
    );
    expect(screen.getByText("To")).toBeTruthy();
    expect(screen.getByText("sam@example.com")).toBeTruthy();
    const subject = screen.getByText("A little poem for you");
    expect(subject.className).toContain("font-semibold");
    // No "Subject:" / "Body:" field labels: it reads as an email.
    expect(screen.queryByText("Body")).toBeNull();
    expect(container.querySelector(".whitespace-pre-wrap")?.textContent).toBe(
      POEM,
    );
  });

  it("draws an event as a calendar entry with one 'when' line", () => {
    render(
      <ApprovalPreview
        kind="event"
        details={[
          { label: "Title", value: "Design review" },
          { label: "Start", value: "2026-10-01T10:00:00Z" },
          { label: "End", value: "2026-10-01T11:00:00Z" },
          { label: "Location", value: "Room 4" },
        ]}
      />,
    );
    expect(screen.getByText("Design review")).toBeTruthy();
    expect(
      screen.getByText("Thu, Oct 1, 2026 · 10:00 – 11:00 (UTC)"),
    ).toBeTruthy();
    expect(screen.getByText("Room 4")).toBeTruthy();
  });

  it("keeps unknown fields as rows so nothing is hidden", () => {
    render(
      <ApprovalPreview
        kind="email"
        details={[
          { label: "To", value: "a@b.com" },
          { label: "Note", value: "sent on behalf" },
        ]}
      />,
    );
    expect(screen.getByText("Note:")).toBeTruthy();
  });

  it("falls back to field rows when the summary has no kind", () => {
    render(
      <ApprovalPreview
        kind={undefined}
        details={[{ label: "First name", value: "Test" }]}
      />,
    );
    expect(screen.getByText("First name:")).toBeTruthy();
  });
});
