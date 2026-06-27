"use client";

import { useEffect, useState } from "react";

/** Whole seconds remaining until an RFC 3339 timestamp, clamped at 0. */
const secondsUntil = (iso: string): number => {
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms)
    ? 0
    : Math.max(0, Math.round((ms - Date.now()) / 1000));
};

/** Seconds remaining until `expiresAt` (RFC 3339), clamped at 0, ticking every second. */
export const useCountdown = (expiresAt: string): number => {
  const [remaining, setRemaining] = useState(() => secondsUntil(expiresAt));

  useEffect(() => {
    const tick = () => setRemaining(secondsUntil(expiresAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  return remaining;
};

/** Format a seconds count as `m:ss`. */
export const formatCountdown = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};
