"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { cn } from "@onecli/ui/lib/utils";
import { RAIL_BUTTON, RAIL_BUTTON_IDLE } from "./shell-geometry";

/**
 * How long the pointer must rest on an entry before `onApproach` reads it
 * as a person heading there. The rail is a column of agent squares, so a
 * pointer on its way to the bottom one crosses every square above it; an
 * approach fired on entry alone woke every parked agent the cursor
 * crossed (one pass down a long rail started machines nobody wanted, and
 * the one that was wanted queued behind them). A rest of this long is a
 * hover, not a transit: a pointer crossing a 36px square on its way
 * somewhere else is on it for tens of milliseconds, and a person who
 * stops to read the tooltip is on it for far longer, so the machine still
 * starts well before they click.
 */
export const RAIL_APPROACH_DWELL_MS = 250;

/**
 * One rail entry: a square with a tooltip naming it. Icon-only on purpose,
 * the rail is the narrow column the mock draws at 60px. `onApproach` fires
 * when a person heads for the entry: on keyboard focus at once (focus is
 * deliberate), on hover only once the pointer has rested on it for
 * `RAIL_APPROACH_DWELL_MS` (a pointer passing through fires nothing).
 */
export const RailItem = ({
  label,
  active,
  href,
  onClick,
  onApproach,
  disabled,
  className,
  children,
}: {
  label: string;
  active?: boolean;
  href?: string;
  onClick?: () => void;
  onApproach?: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) => {
  // The dwell timer. Plain functions, not memoized: the caller passes a
  // fresh `onApproach` each render anyway, and the timer reads the one
  // current at pointer enter.
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelDwell = () => {
    if (dwell.current !== null) {
      clearTimeout(dwell.current);
      dwell.current = null;
    }
  };
  const startDwell = () => {
    if (!onApproach) return;
    cancelDwell();
    dwell.current = setTimeout(() => {
      dwell.current = null;
      onApproach();
    }, RAIL_APPROACH_DWELL_MS);
  };
  // An entry that unmounts mid-dwell (the list re-sorts, a route change)
  // must not fire after it is gone.
  useEffect(() => {
    return () => {
      if (dwell.current !== null) clearTimeout(dwell.current);
    };
  }, []);

  const classes = cn(
    RAIL_BUTTON,
    active ? "bg-brand-wash text-brand-ink" : RAIL_BUTTON_IDLE,
    disabled && "pointer-events-none opacity-50",
    className,
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {href ? (
          <Link
            href={href}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            onPointerEnter={startDwell}
            onPointerLeave={cancelDwell}
            onFocus={onApproach}
            className={classes}
          >
            {children}
          </Link>
        ) : (
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            disabled={disabled}
            className={classes}
          >
            {children}
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
};
