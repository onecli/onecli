"use client";

import { useEffect, useState } from "react";

/** Whole seconds from `now` until an RFC 3339 timestamp, clamped at 0. */
export const secondsUntil = (iso: string, now: number): number => {
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? 0 : Math.max(0, Math.round((ms - now) / 1000));
};

/** The current time (ms epoch), re-read every second: for render logic that
 *  depends on the clock, which must not call `Date.now()` while rendering. */
export const useNow = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
};

/** Seconds remaining until `expiresAt` (RFC 3339), clamped at 0, ticking every
 *  second. A component that needs the clock too reads `useNow` once and
 *  calls `secondsUntil` itself, so it runs one timer, not two. */
export const useCountdown = (expiresAt: string): number =>
  secondsUntil(expiresAt, useNow());

/** Format a seconds count as `m:ss`. */
export const formatCountdown = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};
