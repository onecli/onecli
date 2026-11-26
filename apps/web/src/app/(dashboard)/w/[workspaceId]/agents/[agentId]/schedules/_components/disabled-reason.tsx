"use client";

import { useState, type ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { cn } from "@onecli/ui/lib/utils";

/**
 * A row action that can be unavailable. A disabled button gets no pointer
 * events (no hover, no title), so the wrapper carries the "not allowed"
 * cursor and a tooltip that says why. The wrapper is the same element
 * either way, so the button is never remounted (focus and identity survive)
 * when it turns on or off. The tooltip is always controlled, and only
 * opens while there is a reason to show.
 */
export const DisabledReason = ({
  reason,
  children,
}: {
  /** Why the action can't be used now; null when it can. */
  reason: string | null;
  children: ReactNode;
}) => {
  const [hovered, setHovered] = useState(false);
  return (
    <Tooltip open={hovered && reason !== null} onOpenChange={setHovered}>
      <TooltipTrigger asChild>
        <span
          tabIndex={reason ? 0 : undefined}
          className={cn("inline-flex", reason && "cursor-not-allowed")}
        >
          {children}
        </span>
      </TooltipTrigger>
      {reason && <TooltipContent className="max-w-60">{reason}</TooltipContent>}
    </Tooltip>
  );
};
