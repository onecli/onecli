// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoadOlderSentinel } from "./load-older-sentinel";

/**
 * The unit is the trigger discipline: observe only while armed, fire on
 * intersection, hold while a page is in flight. jsdom has no
 * IntersectionObserver, so the test installs a controllable stub — the same
 * approach the codebase takes for scroll geometry in
 * following-viewport.test.tsx.
 */

type IOCallback = (entries: { isIntersecting: boolean }[]) => void;

let observers: { callback: IOCallback; observed: Element[] }[] = [];

class StubIntersectionObserver {
  observed: Element[] = [];
  constructor(private callback: IOCallback) {
    observers.push({ callback, observed: this.observed });
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {
    observers = observers.filter((o) => o.observed !== this.observed);
  }
  unobserve() {}
}

beforeEach(() => {
  observers = [];
  vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const intersect = () => {
  for (const { callback } of observers) callback([{ isIntersecting: true }]);
};

describe("LoadOlderSentinel", () => {
  it("fires when the reader nears the top", () => {
    const onLoadOlder = vi.fn();
    render(
      <LoadOlderSentinel hasOlder loading={false} onLoadOlder={onLoadOlder} />,
    );
    expect(observers).toHaveLength(1);

    intersect();
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it("does not observe at all while a page is in flight — no double fetch", () => {
    const onLoadOlder = vi.fn();
    render(<LoadOlderSentinel hasOlder loading onLoadOlder={onLoadOlder} />);
    expect(observers).toHaveLength(0);
    // And the in-flight state is visible: the skeleton row renders.
    expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });

  it("renders nothing once history is exhausted", () => {
    const { container } = render(
      <LoadOlderSentinel
        hasOlder={false}
        loading={false}
        onLoadOlder={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(observers).toHaveLength(0);
  });

  it("re-arms after the fetch settles — the observer returns", () => {
    const onLoadOlder = vi.fn();
    const view = render(
      <LoadOlderSentinel hasOlder loading={false} onLoadOlder={onLoadOlder} />,
    );
    intersect();

    // The page lands: loading flips on (observer gone), then off (back).
    view.rerender(
      <LoadOlderSentinel hasOlder loading onLoadOlder={onLoadOlder} />,
    );
    expect(observers).toHaveLength(0);
    view.rerender(
      <LoadOlderSentinel hasOlder loading={false} onLoadOlder={onLoadOlder} />,
    );
    expect(observers).toHaveLength(1);

    intersect();
    expect(onLoadOlder).toHaveBeenCalledTimes(2);
  });
});
