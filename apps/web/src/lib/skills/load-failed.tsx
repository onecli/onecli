"use client";

import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";

export interface LoadFailedProps extends React.ComponentProps<"div"> {
  message: string;
  onRetry: () => void;
}

/** A read that failed, said plainly, with Retry: never shown as "nothing
 * there", which would invite the wrong next step. */
export const LoadFailed = ({
  message,
  onRetry,
  className,
  ...props
}: LoadFailedProps) => (
  <div
    role="alert"
    className={cn(
      "flex flex-wrap items-center gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
      className,
    )}
    {...props}
  >
    <AlertTriangle className="size-4 shrink-0" aria-hidden />
    <span className="min-w-0 flex-1">{message}</span>
    <Button size="xs" variant="outline" onClick={onRetry}>
      <RotateCw className="size-3.5" />
      Retry
    </Button>
  </div>
);
