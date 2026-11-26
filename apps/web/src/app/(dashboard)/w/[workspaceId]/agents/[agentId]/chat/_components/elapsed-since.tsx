"use client";

import { useEffect, useState } from "react";

/** "12s", then "1m 05s". */
export const formatElapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
};

/**
 * Time since `since` (ISO), ticking once a second for as long as it is
 * mounted. Its own component so the tick re-renders this one span, not the
 * card around it: mount it only while the clock should run.
 */
export const ElapsedSince = ({ since }: { since: string }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="tabular-nums">
      {formatElapsed(now - Date.parse(since))}
    </span>
  );
};
