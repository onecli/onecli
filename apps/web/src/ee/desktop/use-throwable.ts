"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

export const DOCK_CORNERS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;
export type DockCorner = (typeof DOCK_CORNERS)[number];

/** A press that wanders less than this is a click, not a drag. */
const DRAG_SLOP_PX = 4;
/** UIScrollView's normal deceleration: where a throw would coast to, so a
 * flick toward a corner lands there even when let go halfway. */
const DECELERATION_RATE = 0.998;
const PROJECTION_MS = DECELERATION_RATE / (1 - DECELERATION_RATE);
/** Only the last moments of a drag say how it was thrown. */
const VELOCITY_WINDOW_MS = 100;
/** The glide into a corner: quick, with the faintest settle past it. */
const SETTLE = "transform 420ms cubic-bezier(0.22, 1.12, 0.36, 1)";

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface Sample {
  t: number;
  x: number;
  y: number;
}
interface Gesture {
  id: number;
  /** The pointer where the press began. */
  startX: number;
  startY: number;
  /** The item's offset from its corner when the press began. */
  fromX: number;
  fromY: number;
  /** The offset now, clamped to the area. */
  x: number;
  y: number;
  rest: DOMRect;
  area: DOMRect;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  moved: boolean;
  samples: Sample[];
}

/** Where a throw coasts to from `position` at `velocity` (px per ms). */
export const projectThrow = (position: number, velocity: number): number =>
  position + velocity * PROJECTION_MS;

/** The corner whose quarter of the area holds the point. */
export const cornerAt = (x: number, y: number, area: Box): DockCorner => {
  const vertical = y < area.top + area.height / 2 ? "top" : "bottom";
  const horizontal = x < area.left + area.width / 2 ? "left" : "right";
  return `${vertical}-${horizontal}` as const;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const velocityOf = (samples: Sample[], now: number) => {
  const recent = samples.filter((s) => now - s.t <= VELOCITY_WINDOW_MS);
  const first = recent[0];
  const last = recent.at(-1);
  if (!first || !last || last.t <= first.t) return { x: 0, y: 0 };
  const dt = last.t - first.t;
  return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
};

const place = (el: HTMLElement, x: number, y: number) => {
  el.style.transform = x || y ? `translate3d(${x}px, ${y}px, 0)` : "";
};

/** Glide from an offset back to the resting corner (the offset's zero). */
const settle = (el: HTMLElement, x: number, y: number) => {
  el.style.transition = "none";
  place(el, x, y);
  if (!x && !y) return;
  // Commit the start before the transition, or there is nothing to glide.
  el.getBoundingClientRect();
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.style.transition = SETTLE;
  }
  place(el, 0, 0);
};

/**
 * Picture-in-picture handling for the floating screen: drag it anywhere in
 * `area`, throw it, and it glides into the corner the throw was heading
 * for (the iOS gesture: the release velocity is projected forward, so a
 * flick is enough). The corner is the state; the drag is only a transform
 * on top of it, so CSS keeps the item in place as the area resizes.
 *
 * A press that never moves is an ordinary click on whatever is under it;
 * the click that ends a drag is swallowed, so a throw never opens the
 * screen. Spread `handlers` on the item, which `ref` must point at.
 */
export const useThrowable = ({
  area,
  corner,
  onCorner,
}: {
  area: RefObject<HTMLElement | null>;
  corner: DockCorner;
  onCorner: (corner: DockCorner) => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const dragged = useRef(false);
  const flipFrom = useRef<{ left: number; top: number } | null>(null);

  // A new corner lands in layout first; the item then glides there from
  // where it was let go (FLIP), instead of jumping.
  useLayoutEffect(() => {
    const el = ref.current;
    const from = flipFrom.current;
    flipFrom.current = null;
    if (!el || !from) return;
    el.style.transition = "none";
    place(el, 0, 0);
    const rest = el.getBoundingClientRect();
    settle(el, from.left - rest.left, from.top - rest.top);
  }, [corner]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    dragged.current = false;
    const el = ref.current;
    const zone = area.current;
    if (!el || !zone || !event.isPrimary || event.button !== 0) return;
    // Caught mid-glide: carry on from where it is on screen right now.
    const visual = el.getBoundingClientRect();
    el.style.transition = "none";
    place(el, 0, 0);
    const rest = el.getBoundingClientRect();
    const fromX = visual.left - rest.left;
    const fromY = visual.top - rest.top;
    place(el, fromX, fromY);
    const box = zone.getBoundingClientRect();
    // The resting inset from the area's edges, kept on every side.
    const insetX = corner.endsWith("left")
      ? rest.left - box.left
      : box.right - rest.right;
    const insetY = corner.startsWith("top")
      ? rest.top - box.top
      : box.bottom - rest.bottom;
    gesture.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      fromX,
      fromY,
      x: fromX,
      y: fromY,
      rest,
      area: box,
      minX: box.left + insetX - rest.left,
      maxX: box.right - insetX - rest.right,
      minY: box.top + insetY - rest.top,
      maxY: box.bottom - insetY - rest.bottom,
      moved: false,
      samples: [{ t: event.timeStamp, x: event.clientX, y: event.clientY }],
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    const el = ref.current;
    if (!g || !el || event.pointerId !== g.id) return;
    const dx = event.clientX - g.startX;
    const dy = event.clientY - g.startY;
    if (!g.moved) {
      if (Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
      g.moved = true;
      // Only now: a capture taken on press would retarget a plain click
      // away from the button under it. A pointer already gone (released
      // between events) cannot be captured; the drag carries on without.
      try {
        el.setPointerCapture(event.pointerId);
      } catch {
        /* nothing to capture */
      }
      window.getSelection()?.removeAllRanges();
      setDragging(true);
    }
    g.x = clamp(g.fromX + dx, g.minX, g.maxX);
    g.y = clamp(g.fromY + dy, g.minY, g.maxY);
    place(el, g.x, g.y);
    g.samples.push({ t: event.timeStamp, x: event.clientX, y: event.clientY });
    if (g.samples.length > 16) g.samples.shift();
  };

  const end = (event: React.PointerEvent<HTMLDivElement>, thrown: boolean) => {
    const g = gesture.current;
    const el = ref.current;
    if (!g || event.pointerId !== g.id) return;
    gesture.current = null;
    if (!el) return;
    if (!g.moved) {
      // A click, or a press that caught a glide: finish going home.
      settle(el, g.x, g.y);
      return;
    }
    dragged.current = true;
    setDragging(false);
    g.samples.push({ t: event.timeStamp, x: event.clientX, y: event.clientY });
    const velocity = thrown
      ? velocityOf(g.samples, event.timeStamp)
      : { x: 0, y: 0 };
    const next = cornerAt(
      projectThrow(g.rest.left + g.x + g.rest.width / 2, velocity.x),
      projectThrow(g.rest.top + g.y + g.rest.height / 2, velocity.y),
      g.area,
    );
    if (next === corner) {
      settle(el, g.x, g.y);
      return;
    }
    flipFrom.current = { left: g.rest.left + g.x, top: g.rest.top + g.y };
    onCorner(next);
  };

  return {
    ref,
    dragging,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (event: React.PointerEvent<HTMLDivElement>) =>
        end(event, true),
      onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) =>
        end(event, false),
      // The click that ends a drag is not a click on the screen.
      onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => {
        if (!dragged.current) return;
        dragged.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
};
