"use client";

import { cn } from "@onecli/ui/lib/utils";
import { IS_CLOUD } from "@/lib/env";

export interface CloudUpsellProps {
  /** Copy before the "OneCLI Cloud" link, e.g. "Or use". */
  before: string;
  /** Copy after the link, e.g. "for pre-configured connections." */
  after: string;
  className?: string;
}

/**
 * The "or use OneCLI Cloud" one-liner shown beside custom-credential setup.
 * Owns the edition gate — renders nothing on cloud, where the reader is
 * already there.
 */
export const CloudUpsell = ({ before, after, className }: CloudUpsellProps) => {
  if (IS_CLOUD) return null;
  return (
    <p className={cn("text-muted-foreground text-xs", className)}>
      {before}{" "}
      <a
        href="https://app.onecli.sh"
        target="_blank"
        rel="noopener noreferrer"
        className="text-foreground font-medium underline underline-offset-2 transition-colors hover:text-foreground/80"
      >
        OneCLI Cloud
      </a>{" "}
      {after}
    </p>
  );
};
