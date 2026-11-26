// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * The Slack block on top of Contacts. The
 * card's own behaviour is `channels-section.test.tsx`.
 */

vi.mock("../../channels/_components/channels-section", () => ({
  ChannelsSection: () => <div data-testid="channels-section" />,
}));

const { ContactsSlackBlock } = await import("./contacts-slack-block");

describe("ContactsSlackBlock", () => {
  it("renders the Slack card under a #slack anchor", () => {
    render(<ContactsSlackBlock />);
    const block = screen.getByRole("region", { name: "Slack" });
    expect(block).toHaveAttribute("id", "slack");
    expect(screen.getByTestId("channels-section")).toBeInTheDocument();
  });
});
