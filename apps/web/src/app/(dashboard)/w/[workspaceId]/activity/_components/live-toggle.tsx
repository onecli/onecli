"use client";

import { Radio } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";

/** Activity's Live switch: while on, the tab refreshes on its own. Shared by
 *  the Network and Runs tabs. */
export const LiveToggle = ({
  live,
  onToggle,
}: {
  live: boolean;
  onToggle: () => void;
}) => (
  <button
    type="button"
    aria-pressed={live}
    onClick={onToggle}
    className="hover:bg-muted focus-visible:ring-ring flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
  >
    <Radio
      aria-hidden
      className={cn(
        "size-3.5",
        live
          ? "text-green-500 motion-safe:animate-pulse"
          : "text-muted-foreground",
      )}
    />
    Live
  </button>
);
