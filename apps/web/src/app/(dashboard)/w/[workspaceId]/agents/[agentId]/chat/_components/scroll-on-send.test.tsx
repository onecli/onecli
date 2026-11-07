// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollOnSend } from "./scroll-on-send";
import { PIN_SCROLL_MARGIN_PX } from "./transcript-layout";

const scrollToMessage = vi.fn();
const scrollToEnd = vi.fn();
vi.mock("@onecli/ui/components/message-scroller", () => ({
  useMessageScroller: () => ({ scrollToMessage, scrollToEnd }),
}));

beforeEach(() => {
  scrollToMessage.mockClear();
  scrollToEnd.mockClear();
});

describe("ScrollOnSend", () => {
  it("puts a fresh send near the top, through the scroller", () => {
    // MUTATION-TESTED: a raw scrollTop write instead left the scroller
    // "following the bottom", so it hid the end button while the reply ran
    // below the fold.
    render(<ScrollOnSend sent={{ message: "ask" }} pin />);
    expect(scrollToMessage).toHaveBeenCalledExactlyOnceWith("pending", {
      align: "start",
      scrollMargin: PIN_SCROLL_MARGIN_PX,
    });
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it("takes a follow-up to the end, so the reader sees it and follows again", () => {
    // MUTATION-TESTED: without it a follow-up sent under a reply that had
    // passed the fold landed off-screen, and nothing followed the answer.
    render(<ScrollOnSend sent={{ message: "and also" }} pin={false} />);
    expect(scrollToEnd).toHaveBeenCalledOnce();
    expect(scrollToMessage).not.toHaveBeenCalled();
  });

  it("moves the view once per send, never without one", () => {
    const sent = { message: "ask" };
    const { rerender } = render(<ScrollOnSend sent={undefined} pin={false} />);
    rerender(<ScrollOnSend sent={sent} pin />);
    rerender(<ScrollOnSend sent={sent} pin />);
    rerender(<ScrollOnSend sent={undefined} pin />);
    expect(scrollToMessage).toHaveBeenCalledOnce();
    expect(scrollToEnd).not.toHaveBeenCalled();
  });
});
