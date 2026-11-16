"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { prefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import {
  advance,
  cutAt,
  holdPartialTable,
  initialPacer,
  onTarget,
  type Pacer,
} from "./smooth-reveal";

/** Read once per reply, when it mounts: a reply never switches pacing
 *  halfway through. A tab nobody is looking at does not animate either:
 *  frames do not run there, and coming back to an answer that then starts
 *  flowing from nothing would replay what already arrived. */
const prefersInstant = (): boolean =>
  typeof window !== "undefined" &&
  (prefersReducedMotion() || document.visibilityState === "hidden");

/**
 * Text as it should be ON SCREEN this frame: `target` revealed at a steady
 * pace instead of in network-sized jumps (the engine and its rules are in
 * `smooth-reveal.ts`).
 *
 * - `animate: false` (history, a page load) returns `target` as is:
 *   nothing that was already complete is ever re-animated.
 * - `final: true` says no more text is coming: the rest is caught up within
 *   250ms, or, for an answer that arrived whole in front of the reader,
 *   flows in at a reading pace (see `smooth-reveal.ts`).
 * - A target that does not extend what is shown (a correction, or the final
 *   answer differing from the draft) is shown at once.
 * - Under reduced motion the text is always shown whole.
 *
 * The animation lives HERE, in the leaf that renders the text: one frame
 * loop per streaming reply, re-rendering only that component, never the
 * thread around it.
 */
export const useSmoothText = (
  target: string,
  { animate, final }: { animate: boolean; final: boolean },
): string => {
  // Decided once per mount: a reply that started streaming keeps animating
  // to its end, and one that mounted complete never starts.
  const [live] = useState(() => animate && !prefersInstant());
  const [shown, setShown] = useState(() => (live ? "" : target));
  const pacer = useRef<Pacer>(initialPacer(live ? 0 : target.length));
  const shownRef = useRef(shown);
  const frame = useRef<number | null>(null);
  const lastFrameAt = useRef<number | null>(null);

  const show = (next: string) => {
    shownRef.current = next;
    setShown(next);
  };

  // One frame of the reveal: advance, cut at a word, show. An Effect Event,
  // so it always reads the latest target without the loop restarting on
  // every batch. Returns whether more frames are needed.
  const step = useEffectEvent((now: number): boolean => {
    const elapsed =
      lastFrameAt.current === null ? 16 : now - lastFrameAt.current;
    lastFrameAt.current = now;
    pacer.current = advance(pacer.current, target.length, elapsed);
    const end = holdPartialTable(target, cutAt(target, pacer.current.shown));
    if (end > shownRef.current.length) show(target.slice(0, end));
    if (pacer.current.shown < target.length) return true;
    // Caught up: the last word may sit past the last boundary. A table
    // still forming at the very end waits for its next batch (or the
    // final text) rather than flashing as pipes.
    const whole = final
      ? target.length
      : holdPartialTable(target, target.length);
    if (whole > shownRef.current.length) show(target.slice(0, whole));
    lastFrameAt.current = null;
    return false;
  });

  /** Run frames until the reveal has caught up. Idempotent while running. */
  const run = useEffectEvent(() => {
    if (frame.current !== null) return;
    const loop = (now: number) => {
      frame.current = step(now) ? requestAnimationFrame(loop) : null;
    };
    frame.current = requestAnimationFrame(loop);
  });

  // Re-plan whenever the target grows, or the text becomes final.
  useEffect(() => {
    if (!live) return;
    if (
      !target.startsWith(shownRef.current) ||
      document.visibilityState === "hidden"
    ) {
      // Not an extension, or nobody is looking: show the new text at once
      // (a snap, never a backwards animation, never a replay on return).
      pacer.current = initialPacer(target.length);
      show(target);
      return;
    }
    pacer.current = onTarget(
      pacer.current,
      target.length,
      performance.now(),
      final,
    );
    // Also when the pacer is caught up but something is still held back (a
    // forming table): the final text releases it.
    if (
      pacer.current.shown < target.length ||
      shownRef.current.length < target.length
    )
      run();
  }, [target, final, live]);

  useEffect(
    () => () => {
      // Clear the handle too, not just the frame: StrictMode (and any
      // remount that keeps the refs) runs the effects again, and a stale
      // handle would make `run` think a loop is going when none is, and the
      // reply would never appear.
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      lastFrameAt.current = null;
    },
    [],
  );

  return live ? shown : target;
};
