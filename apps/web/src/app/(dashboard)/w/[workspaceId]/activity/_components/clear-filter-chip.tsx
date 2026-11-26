"use client";

import { X } from "lucide-react";

/**
 * A removable filter on an Activity tab ("During one run", "Webhook: …"):
 * the label is the narrowing, and clicking the chip clears it.
 */
export const ClearFilterChip = ({
  children,
  onClick,
}: Pick<React.ComponentProps<"button">, "children" | "onClick">) => (
  <button
    type="button"
    onClick={onClick}
    className="hover:bg-muted focus-visible:ring-ring flex max-w-64 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs focus-visible:ring-2 focus-visible:outline-none"
  >
    <span className="truncate">{children}</span>
    <X className="size-3 shrink-0" aria-hidden />
    <span className="sr-only">(clear)</span>
  </button>
);
