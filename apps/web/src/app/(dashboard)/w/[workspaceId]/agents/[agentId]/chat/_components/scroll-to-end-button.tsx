"use client";

import { ArrowDownIcon, ChevronRightIcon } from "lucide-react";
import { MessageScrollerButton } from "@onecli/ui/components/message-scroller";
import { cn } from "@onecli/ui/lib/utils";

const FlowChevron = ({ delay }: { delay: string }) => (
  <ChevronRightIcon
    style={{ animationDelay: delay }}
    className="-mx-1 size-3.5 stroke-3 motion-safe:animate-chevron-flow"
  />
);

export interface ScrollToEndButtonProps extends React.ComponentProps<
  typeof MessageScrollerButton
> {
  /** The agent is still writing below the fold. */
  generating?: boolean;
}

/**
 * The transcript's scroll-to-end button: round and lifted so it reads over
 * the text behind it (the stock one is a small flat icon that blends in).
 * While the agent is still writing (`generating`) it shows the OneCLI `>>`
 * flowing instead of the arrow; hover or keyboard focus brings the arrow
 * back. Styled via `className`, so the vendored shadcn button stays
 * untouched, and the click keeps the stock behavior: scroll to the end and
 * resume following.
 */
export const ScrollToEndButton = ({
  className,
  generating = false,
  ...props
}: ScrollToEndButtonProps) => (
  <MessageScrollerButton
    size="icon"
    className={cn("group/end rounded-full border shadow-md", className)}
    {...props}
  >
    <ArrowDownIcon
      className={cn(
        "size-[18px] stroke-[2.25]",
        generating &&
          "hidden group-hover/end:block group-focus-visible/end:block",
      )}
    />
    {generating && (
      <span className="text-brand flex group-hover/end:hidden group-focus-visible/end:hidden">
        <FlowChevron delay="0s" />
        <FlowChevron delay="0.2s" />
      </span>
    )}
    <span className="sr-only">
      {generating ? "Scroll to end, still writing" : "Scroll to end"}
    </span>
  </MessageScrollerButton>
);
