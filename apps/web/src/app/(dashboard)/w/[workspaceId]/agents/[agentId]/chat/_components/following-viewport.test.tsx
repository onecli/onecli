// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageScrollerProvider } from "@onecli/ui/components/message-scroller";
import { FollowingViewport } from "./following-viewport";

/**
 * The shim's contract, stated as the reader experiences it: a gesture that
 * could not move the viewport must not cost them follow-mode, and a gesture
 * that genuinely scrolls away must still release it.
 *
 * `scrollToEnd` is the observable: it is exactly what re-arms following in the
 * primitive, so "did the shim re-arm" is "was scrollToEnd re-issued". The
 * scroller's own follow-mode is private state with no test seam, which is why
 * the assertion sits on the call rather than on a resulting scrollTop (jsdom
 * has no layout, so scrollTop would be a fiction here either way).
 */

const scrollToEnd = vi.fn();
vi.mock("@onecli/ui/components/message-scroller", async () => {
  const actual = await vi.importActual<
    typeof import("@onecli/ui/components/message-scroller")
  >("@onecli/ui/components/message-scroller");
  return { ...actual, useMessageScroller: () => ({ scrollToEnd }) };
});

/** jsdom reports 0 for every box; place the viewport at a chosen distance. */
const positionAt = (el: HTMLElement, distanceFromBottom: number) => {
  Object.defineProperty(el, "scrollHeight", {
    value: 1000,
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
  Object.defineProperty(el, "scrollTop", {
    value: 600 - distanceFromBottom,
    writable: true,
    configurable: true,
  });
};

/** Run the queued rAF callback the shim schedules. */
const nextFrame = async () => {
  await vi.advanceTimersByTimeAsync(20);
};

const renderViewport = () => {
  render(
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <FollowingViewport>
        <div>transcript</div>
      </FollowingViewport>
    </MessageScrollerProvider>,
  );
  return screen.getByRole("region", { name: "Messages" });
};

beforeEach(() => {
  scrollToEnd.mockClear();
  // Fake `requestAnimationFrame` itself (rather than stubbing it with a
  // timer), so the shim's `cancelAnimationFrame` on unmount cancels the same
  // kind of handle it scheduled.
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FollowingViewport", () => {
  it("re-arms following after a wheel toward the end at the bottom", async () => {
    // The reported bug: one nudge of the trackpad at the live edge and the
    // transcript stopped following the stream for good.
    const viewport = renderViewport();
    positionAt(viewport, 0);

    fireEvent.wheel(viewport, { deltaY: 3 });
    await nextFrame();

    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("leaves a reader who scrolled away alone", async () => {
    // The other half of the contract: once the reader is off the bottom,
    // nothing may pull them back — that is what the arrow is for.
    const viewport = renderViewport();
    positionAt(viewport, 250);

    fireEvent.wheel(viewport, { deltaY: 3 });
    await nextFrame();

    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it("does not re-arm on a wheel away from the end", async () => {
    // A wheel-up at the bottom is the reader deliberately leaving the live
    // edge; re-arming there would fight them.
    const viewport = renderViewport();
    positionAt(viewport, 0);

    fireEvent.wheel(viewport, { deltaY: -120 });
    await nextFrame();

    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it("re-arms when a scroll key at the bottom moves nothing", async () => {
    const viewport = renderViewport();
    positionAt(viewport, 0);

    fireEvent.keyDown(viewport, { key: "ArrowDown" });
    await nextFrame();

    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("ignores keys that are not scroll intent", async () => {
    const viewport = renderViewport();
    positionAt(viewport, 0);

    fireEvent.keyDown(viewport, { key: "a" });
    await nextFrame();

    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it("does not re-arm when the gesture actually scrolled away", async () => {
    // The safety property the whole design rests on: a real scroll-away
    // commits its new position before the frame runs, so the re-check sees
    // the reader off the bottom and stands down.
    const viewport = renderViewport();
    positionAt(viewport, 0);

    fireEvent.wheel(viewport, { deltaY: 120 });
    positionAt(viewport, 300); // the browser's scroll lands first
    await nextFrame();

    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it("re-arms on a touch drag that moved nothing", async () => {
    const viewport = renderViewport();
    positionAt(viewport, 0);

    fireEvent.touchMove(viewport);
    await nextFrame();

    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("leaves a touch drag that scrolled away alone", async () => {
    // The mobile half of the safety property: a swipe back through history
    // must not be pulled to the live edge.
    const viewport = renderViewport();
    positionAt(viewport, 0);

    fireEvent.touchMove(viewport);
    positionAt(viewport, 300); // the swipe's scroll lands
    await nextFrame();

    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it("still forwards the handlers it wraps", async () => {
    const onWheel = vi.fn();
    render(
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <FollowingViewport onWheel={onWheel}>
          <div>transcript</div>
        </FollowingViewport>
      </MessageScrollerProvider>,
    );
    const viewport = screen.getByRole("region", { name: "Messages" });
    positionAt(viewport, 0);

    fireEvent.wheel(viewport, { deltaY: 3 });

    expect(onWheel).toHaveBeenCalledTimes(1);
  });
});
