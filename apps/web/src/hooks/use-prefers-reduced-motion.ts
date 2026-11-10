"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

const subscribe = (onChange: () => void) => {
  const list = window.matchMedia?.(QUERY);
  list?.addEventListener?.("change", onChange);
  return () => list?.removeEventListener?.("change", onChange);
};

/** The reader's setting right now, for a decision made once (a scroll, a
 *  reveal deciding whether to animate at all). False where it cannot be
 *  read (the server, an old engine). */
export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia?.(QUERY).matches === true;

const read = prefersReducedMotion;
/** The server cannot know: render the motion-free markup, which is also
 *  what a reader with reduced motion gets. */
const readOnServer = () => true;

/** Whether the reader asked for reduced motion, kept current if they change
 *  it while the page is open. */
export const usePrefersReducedMotion = (): boolean =>
  useSyncExternalStore(subscribe, read, readOnServer);
