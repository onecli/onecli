"use client";

import * as React from "react";
import {
  MessageScrollerViewport,
  useMessageScroller,
} from "@onecli/ui/components/message-scroller";

/**
 * The transcript viewport, with follow-output that survives gestures that
 * move nothing.
 *
 * WHY THIS EXISTS — an upstream bug, not one of ours. `@shadcn/react`'s
 * scroller releases follow-output from `userScrollIntent`, which fires on
 * EVERY wheel, touchmove and scroll key without looking at the direction.
 * While the reader sits at the live edge the viewport is already clamped at
 * max `scrollTop`, so such a gesture moves nothing and no `scroll` event ever
 * follows — and that scroll event is the only thing that re-arms following.
 * One nudge of the trackpad (a `deltaY` of 3 is enough) or one press of the
 * space bar, and the transcript stops following the stream for good: replies
 * keep landing below the fold and only the scroll-to-end button brings the
 * reader back.
 *
 * Reported upstream as shadcn-ui/ui#11224, with a fix in shadcn-ui/ui#11223.
 * Both are still open and 0.3.0 is the latest release, so the behavior has to
 * be restored from out here rather than by upgrading. DELETE THIS FILE once
 * that fix ships: `chat-thread.tsx` goes back to the stock
 * `MessageScrollerViewport` and the shim's whole reason to exist is gone.
 *
 * It lives here, beside its only consumer, rather than in `packages/ui`:
 * `packages/ui/src/components/` holds shadcn components kept byte-identical to
 * the registry (see CLAUDE.md), and this is app-level compensation, not a
 * component of ours. The vendored `message-scroller.tsx` stays untouched.
 *
 * HOW — the same rule as the upstream patch, expressed through the scroller's
 * public API only. A gesture toward the end, taken while the viewport is
 * ALREADY at the bottom, is not scroll-away intent: re-arm following by
 * re-issuing the scroller's own `scrollToEnd()` on the next frame.
 *
 * Why the next frame is the right seam, and why this can never fight the
 * reader: a gesture that really does scroll away commits its new `scrollTop`
 * BEFORE that frame runs, so the re-check sees the reader off the bottom and
 * does nothing (measured in Chrome: a 300px wheel-up reads 0px from the bottom
 * at event time and 300px two frames later). Only a gesture that moved nothing
 * is still measuring at the live edge by then — exactly the case upstream
 * strands.
 *
 * Touch keeps the re-check as its whole guard, matching the upstream patch —
 * which also passes a direction for `wheel` only. A drag's first `touchmove`
 * can still measure at the bottom (the browser commits its scroll from the
 * second move on), but re-arming there is harmless: the viewport is genuinely
 * still at the live edge, `scrollToEnd()` is a no-op, and the next `touchmove`
 * of the same drag releases follow again once the scroll has landed. Tracking
 * the finger's own direction was tried and measurably changed nothing, so the
 * simpler code that matches upstream is what ships.
 */

/**
 * Keys the scroller itself counts as scroll intent, filtered to the ones that
 * move toward the end. At the bottom they scroll nothing, which is the same
 * trap as trailing wheel momentum.
 */
const KEYS_TOWARD_END = new Set(["ArrowDown", "End", "PageDown", " "]);

/**
 * How close to the bottom still counts as being at the live edge. Mirrors the
 * primitive's own `scrollEdgeThreshold` default, so this re-arms on exactly
 * the positions the scroller considers pinned.
 */
const EDGE_THRESHOLD_PX = 8;

const distanceFromBottom = (el: HTMLElement): number =>
  el.scrollHeight - el.scrollTop - el.clientHeight;

export const FollowingViewport = ({
  onWheel,
  onKeyDown,
  onTouchMove,
  ref,
  ...props
}: React.ComponentProps<typeof MessageScrollerViewport>) => {
  const { scrollToEnd } = useMessageScroller();
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const frameRef = React.useRef<number | null>(null);

  const setRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      viewportRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  React.useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  // Re-checked on the next frame: by then a genuine scroll-away has committed
  // its new position, and only a no-op gesture is still at the live edge.
  const rearmIfStillPinned = React.useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || frameRef.current !== null) return;
    // Cheap pre-filter, not the guard: wheel events fire in bursts, and a
    // reader scrolling through history should not queue a frame per event.
    // The re-check inside the frame is what actually decides.
    if (distanceFromBottom(viewport) > EDGE_THRESHOLD_PX) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const current = viewportRef.current;
      if (!current || distanceFromBottom(current) > EDGE_THRESHOLD_PX) return;
      scrollToEnd({ behavior: "auto" });
    });
  }, [scrollToEnd]);

  return (
    <MessageScrollerViewport
      ref={setRef}
      onWheel={(event) => {
        // Toward the end only. A wheel-up is real scroll-away intent and must
        // keep releasing follow, or the reader could never leave the bottom.
        // `deltaY === 0` (a horizontal pan) moves nothing vertically either.
        if (event.deltaY >= 0) rearmIfStillPinned();
        onWheel?.(event);
      }}
      onKeyDown={(event) => {
        if (KEYS_TOWARD_END.has(event.key)) rearmIfStillPinned();
        onKeyDown?.(event);
      }}
      onTouchMove={(event) => {
        // No direction to read here, so the at-the-edge re-check is the whole
        // guard (as upstream does): a swipe that really scrolls away has moved
        // the viewport by the time the frame runs.
        rearmIfStillPinned();
        onTouchMove?.(event);
      }}
      {...props}
    />
  );
};
