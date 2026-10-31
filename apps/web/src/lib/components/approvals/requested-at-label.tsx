"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { cn } from "@onecli/ui/lib/utils";
import { formatRequestedAt, formatRequestedAtFull } from "./requested-at";
import { useNow } from "./use-countdown";

export interface RequestedAtLabelProps extends Omit<
  React.ComponentProps<"time">,
  "children"
> {
  createdAt: string;
}

/** When an ask was raised: relative, or the date once a day old; the full
 * timestamp on hover. */
export const RequestedAtLabel = ({
  createdAt,
  className,
  ...props
}: RequestedAtLabelProps) => {
  const now = useNow();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          dateTime={createdAt}
          className={cn(
            "text-muted-foreground shrink-0 text-xs tabular-nums",
            className,
          )}
          {...props}
        >
          {formatRequestedAt(createdAt, now)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{formatRequestedAtFull(createdAt)}</TooltipContent>
    </Tooltip>
  );
};
