"use client";

import { useEffect, useRef, useState } from "react";

/** How long "Not sent · Undo" waits before the decline is final. */
const UNDO_MS = 10_000;

/**
 * A quiet decline ("Don't send", "Not now") with a short undo: the card
 * collapses at once, and the decline is sent only when the window closes
 * (or the card goes away). Undo brings the pending card back untouched.
 */
export const useUndoableDismiss = (decline: () => void) => {
  const [dismissed, setDismissed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(decline);
  useEffect(() => {
    latest.current = decline;
  });

  const flush = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    latest.current();
  };

  useEffect(() => flush, []);

  return {
    dismissed,
    dismiss: () => {
      setDismissed(true);
      timer.current = setTimeout(flush, UNDO_MS);
    },
    undo: () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setDismissed(false);
    },
  };
};
