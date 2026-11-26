"use client";

import { useCallback } from "react";

/**
 * Set or clear one query param on the current URL, keeping the rest (the
 * `?settings=` that holds the modal open above all), without a server
 * round trip.
 *
 * Only for params no server component reads: a tab, a search box, a
 * filter. The client renders from `useSearchParams`, which Next keeps in
 * sync with a native `history.replaceState` (the documented shallow
 * update: `null` state, Next copies its own entry state over), so the tab
 * switches on the click instead of after the `@settings` slot re-renders on
 * the server. Replace, not push: a tab switch is not a place Back should
 * return to. Reads `location` at call time, so two writes in one tick (a
 * keystroke burst) never clobber each other.
 */
export const useReplaceParam = () =>
  useCallback((key: string, value: string | null) => {
    const params = new URLSearchParams(window.location.search);
    if (value) params.set(key, value);
    else params.delete(key);
    const qs = params.toString();
    const { pathname, hash } = window.location;
    window.history.replaceState(
      null,
      "",
      `${pathname}${qs ? `?${qs}` : ""}${hash}`,
    );
  }, []);
