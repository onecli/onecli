"use client";

import { useEffect, useRef, useState } from "react";

/** How long an onboarding screen takes to fade out before moving on. */
export const SCREEN_EXIT_MS = 300;

const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Ease an onboarding screen away before moving on, so the next screen (or
 * the chat) arrives as a transition rather than a hard cut. `leaving` drives
 * the fade; `leave(next)` starts it once (a second click is ignored) and
 * runs `next` when it ends: at once for people who prefer reduced motion,
 * and never after the screen has unmounted.
 */
export const useScreenExit = () => {
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const leave = (next: () => void) => {
    if (timer.current !== undefined) return;
    setLeaving(true);
    timer.current = setTimeout(
      next,
      prefersReducedMotion() ? 0 : SCREEN_EXIT_MS,
    );
  };

  return { leaving, leave };
};
