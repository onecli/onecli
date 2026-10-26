// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageScrollerProvider } from "@onecli/ui/components/message-scroller";
import { ScrollToEndButton } from "./scroll-to-end-button";

const button = (generating: boolean) =>
  render(
    <MessageScrollerProvider>
      <ScrollToEndButton generating={generating} />
    </MessageScrollerProvider>,
  );

describe("ScrollToEndButton", () => {
  it("says the agent is still writing while generating, and not after", () => {
    // MUTATION-TESTED: without it the button looks the same mid-reply as
    // when the reply is done, so nothing says more is coming.
    button(true);
    expect(
      screen.getByText("Scroll to end, still writing"),
    ).toBeInTheDocument();
    button(false);
    expect(screen.getByText("Scroll to end")).toBeInTheDocument();
  });
});
