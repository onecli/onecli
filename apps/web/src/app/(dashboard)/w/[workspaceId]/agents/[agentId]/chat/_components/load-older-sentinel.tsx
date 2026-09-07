"use client";

import * as React from "react";
import { useEffectEvent } from "react";
import { Skeleton } from "@onecli/ui/components/skeleton";

/**
 * The scroll-up loader's trigger: a sentinel row at the TOP of the thread
 * that asks for the next older window as the reader approaches it.
 *
 * An IntersectionObserver with a generous bottom margin, so the fetch fires
 * about one viewport BEFORE the reader actually hits the top — the industry
 * prefetch pattern (the page is usually there by the time they arrive, and
 * the held scroll position hides the seam entirely). The viewport root is
 * found by walking up to the nearest scrollable ancestor rather than plumbed
 * through props: the sentinel lives inside the message scroller's viewport,
 * and `null` (the window) would never intersect for a nested scroller.
 *
 * Re-arming is the observer's own behavior: after a page prepends, the
 * sentinel moves up with the new content; if the reader keeps scrolling it
 * re-enters the margin and fires again. `loading` renders the skeleton row
 * in the sentinel's place so the reader sees the fetch happening.
 */
const PREFETCH_MARGIN_PX = 400;

export interface LoadOlderSentinelProps {
  /** Older pages exist — render and observe. False renders nothing. */
  hasOlder: boolean;
  /** A page is in flight — show the skeleton and hold the trigger. */
  loading: boolean;
  onLoadOlder: () => void;
}

export const LoadOlderSentinel = ({
  hasOlder,
  loading,
  onLoadOlder,
}: LoadOlderSentinelProps) => {
  const ref = React.useRef<HTMLDivElement | null>(null);
  // Effect Event: always the latest callback (the section passes an inline
  // closure) without re-observing per render.
  const fire = useEffectEvent(() => onLoadOlder());

  const armed = hasOlder && !loading;
  React.useEffect(() => {
    const node = ref.current;
    if (!node || !armed) return;

    let root: HTMLElement | null = node.parentElement;
    while (root && root.scrollHeight <= root.clientHeight) {
      root = root.parentElement;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) fire();
      },
      { root, rootMargin: `${PREFETCH_MARGIN_PX}px 0px` },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [armed]);

  if (!hasOlder && !loading) return null;

  return (
    <div ref={ref} aria-hidden className="flex flex-col gap-3 py-1">
      {loading && (
        <>
          <Skeleton className="ms-auto h-8 w-1/3 rounded-lg" />
          <Skeleton className="h-12 w-1/2 rounded-lg" />
        </>
      )}
    </div>
  );
};
