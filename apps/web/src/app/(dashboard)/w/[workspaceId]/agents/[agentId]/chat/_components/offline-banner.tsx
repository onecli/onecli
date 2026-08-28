"use client";

import { AlertTriangle } from "lucide-react";
import { OFFLINE_MESSAGE } from "@/lib/agents/availability";

/**
 * The point-of-impact offline notice for the hosted surfaces. Says what the
 * user's agents can and cannot do right now — never why in infrastructure
 * terms (§3.13). Visual shape follows the house banner (over-quota).
 */
export const OfflineBanner = () => (
  <div className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5 dark:border-amber-500/40 dark:bg-amber-500/15">
    <AlertTriangle className="size-4 shrink-0 text-amber-500" aria-hidden />
    <p className="min-w-0 text-sm">{OFFLINE_MESSAGE}</p>
  </div>
);
