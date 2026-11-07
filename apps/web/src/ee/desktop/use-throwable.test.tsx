// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cornerAt,
  projectThrow,
  useThrowable,
  type DockCorner,
} from "./use-throwable";

const AREA = { left: 0, top: 0, width: 1000, height: 600 };

describe("cornerAt", () => {
  it("is the quarter of the area the point falls in", () => {
    expect(cornerAt(100, 100, AREA)).toBe("top-left");
    expect(cornerAt(900, 100, AREA)).toBe("top-right");
    expect(cornerAt(100, 500, AREA)).toBe("bottom-left");
    expect(cornerAt(900, 500, AREA)).toBe("bottom-right");
  });
});

describe("projectThrow", () => {
  it("stays put with no velocity, and coasts further the faster the throw", () => {
    expect(projectThrow(300, 0)).toBe(300);
    expect(projectThrow(300, 0.5)).toBeGreaterThan(300);
    expect(projectThrow(300, 1)).toBeGreaterThan(projectThrow(300, 0.5));
    expect(projectThrow(300, -0.5)).toBeLessThan(300);
  });

  it("lets a flick land in the far corner though it was let go on this side", () => {
    // Released at x=400 (the left half), thrown right at 1px/ms.
    expect(cornerAt(projectThrow(400, 1), 500, AREA)).toBe("bottom-right");
  });
});

/** A 1000x600 chat with the item resting 16px in from its corner. */
const ITEM = { width: 280, height: 175 };
const restFor = (corner: DockCorner) => ({
  left: corner.endsWith("left") ? 16 : 1000 - 16 - ITEM.width,
  top: corner.startsWith("top") ? 16 : 600 - 16 - ITEM.height,
});
const rect = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;
/** Where the item is on screen: its corner's rest plus its transform. */
const visual = (el: HTMLElement, corner: DockCorner) => {
  const match = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(
    el.style.transform,
  );
  const rest = restFor(corner);
  return rect(
    rest.left + Number(match?.[1] ?? 0),
    rest.top + Number(match?.[2] ?? 0),
    ITEM.width,
    ITEM.height,
  );
};

const Harness = ({
  corner,
  onCorner,
  onClick,
}: {
  corner: DockCorner;
  onCorner: (corner: DockCorner) => void;
  onClick: () => void;
}) => {
  const area = useRef<HTMLDivElement>(null);
  const { ref, handlers } = useThrowable({ area, corner, onCorner });
  return (
    <div ref={area} data-testid="area">
      <div ref={ref} data-testid="item" {...handlers}>
        <button type="button" onClick={onClick}>
          Open
        </button>
      </div>
    </div>
  );
};

const mount = (corner: DockCorner = "bottom-right") => {
  const onCorner = vi.fn();
  const onClick = vi.fn();
  const utils = render(
    <Harness corner={corner} onCorner={onCorner} onClick={onClick} />,
  );
  const item = utils.getByTestId("item");
  vi.spyOn(utils.getByTestId("area"), "getBoundingClientRect").mockReturnValue(
    rect(0, 0, 1000, 600),
  );
  vi.spyOn(item, "getBoundingClientRect").mockImplementation(() =>
    visual(item, corner),
  );
  item.setPointerCapture = vi.fn();
  return { ...utils, item, onCorner, onClick };
};

/** jsdom stamps every event with `Date.now()` (it ignores a passed
 * `timeStamp`), so the test owns the clock: each event lands at `at` ms. */
const pointer = (
  target: HTMLElement,
  type: "pointerDown" | "pointerMove" | "pointerUp",
  x: number,
  y: number,
  at: number,
) => {
  vi.setSystemTime(CLOCK_START + at);
  return fireEvent[type](target, {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
};
const CLOCK_START = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useThrowable", () => {
  it("a press that does not move is an ordinary click, and moves nothing", () => {
    const { item, onCorner, onClick, getByRole } = mount();
    const button = getByRole("button", { name: "Open" });
    pointer(button, "pointerDown", 860, 500, 0);
    pointer(button, "pointerMove", 862, 501, 10);
    pointer(button, "pointerUp", 862, 501, 20);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
    expect(onCorner).not.toHaveBeenCalled();
    expect(item.setPointerCapture).not.toHaveBeenCalled();
  });

  it("a slow drag into another quarter rests there, and swallows the click that ends it", () => {
    const { item, onCorner, onClick, getByRole } = mount();
    const button = getByRole("button", { name: "Open" });
    pointer(button, "pointerDown", 860, 500, 0);
    // Across to the left half, slowly, then held still before letting go.
    for (let i = 1; i <= 10; i++) {
      pointer(item, "pointerMove", 860 - i * 60, 500, i * 50);
    }
    pointer(item, "pointerMove", 260, 500, 900);
    pointer(item, "pointerUp", 260, 500, 1100);
    fireEvent.click(button);
    expect(onCorner).toHaveBeenCalledWith("bottom-left");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("a quick flick upward lands in the top corner though let go in the bottom half", () => {
    const { item, onCorner } = mount();
    pointer(item, "pointerDown", 860, 500, 0);
    pointer(item, "pointerMove", 860, 480, 16);
    pointer(item, "pointerMove", 860, 450, 32);
    pointer(item, "pointerMove", 860, 420, 48);
    pointer(item, "pointerUp", 860, 410, 56);
    expect(onCorner).toHaveBeenCalledWith("top-right");
  });

  it("never leaves the area: the drag is clamped to its edges", () => {
    const { item } = mount();
    pointer(item, "pointerDown", 860, 500, 0);
    pointer(item, "pointerMove", 860, 100, 10);
    pointer(item, "pointerMove", 2000, -900, 20);
    const at = visual(item, "bottom-right");
    expect(at.right).toBeLessThanOrEqual(1000 - 16);
    expect(at.top).toBeGreaterThanOrEqual(16);
    act(() => {
      pointer(item, "pointerUp", 2000, -900, 400);
    });
  });
});
