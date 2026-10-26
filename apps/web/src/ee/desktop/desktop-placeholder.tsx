"use client";

import { ChevronRight } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";

export interface DesktopPlaceholderProps {
  /** One short line: what the screen is doing ("Connecting…"). */
  caption: string;
  /** A sentence under the caption, shown only where the room is wide (the
   * theater), never on the small card. */
  detail?: string;
  /** Work in progress: the chevrons flow and the caption shimmers. At rest
   * (asleep, can't be shown) both are still. */
  busy: boolean;
}

/**
 * What stands in for the agent's screen while there is no picture: the
 * OneCLI `>>` in a disc, and one line. Every such moment (connecting,
 * waking, asleep, paused, can't be shown) is this one design, so the card
 * and the theater never flash between different empty states. Sized from
 * its own width (container query units), so the 280px card and the
 * full-size theater read as the same object at two scales.
 */
export const DesktopPlaceholder = ({
  caption,
  detail,
  busy,
}: DesktopPlaceholderProps) => {
  // The chat's "still writing" mark (ScrollToEndButton): each chevron
  // glides right and brightens in turn. Still under reduced motion.
  const chevron = cn(
    "-mx-[0.2em] size-[1em] stroke-[3.5]",
    busy && "motion-safe:animate-chevron-flow",
  );
  return (
    <div
      role="status"
      className="bg-muted text-muted-foreground @container absolute inset-0"
    >
      <div className="flex size-full flex-col items-center justify-center gap-[clamp(0.5rem,2.4cqw,1rem)] px-[6cqw] text-center">
        <span
          aria-hidden
          className="bg-muted-foreground/75 text-muted flex size-[clamp(2.5rem,11cqw,4.5rem)] items-center justify-center rounded-full pl-[0.08em] text-[clamp(1.25rem,5.4cqw,2.25rem)]"
        >
          <ChevronRight className={chevron} />
          <ChevronRight
            className={chevron}
            style={busy ? { animationDelay: "0.2s" } : undefined}
          />
        </span>
        <span
          className={cn(
            "text-[clamp(0.75rem,2.3cqw,0.9375rem)] font-medium",
            // The chat's in-progress idiom (ActivityLine): a slow highlight
            // across the words. Still under reduced motion.
            busy &&
              "from-muted-foreground/45 via-foreground/70 to-muted-foreground/45 motion-safe:animate-shimmer bg-gradient-to-r bg-[length:200%_100%] bg-clip-text text-transparent motion-reduce:bg-none motion-reduce:text-inherit",
          )}
        >
          {caption}
        </span>
        {detail && (
          <span className="hidden max-w-sm text-xs leading-relaxed @md:block">
            {detail}
          </span>
        )}
      </div>
    </div>
  );
};
