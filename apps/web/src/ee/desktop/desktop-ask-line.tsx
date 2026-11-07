"use client";

import { CircleAlert } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";

/**
 * The agent's open ask, in one line: "Needs you: <reason>". Rendered over
 * the floating card, above the theater's control pill, and in the theater
 * page's bar, so the person reads what to do wherever they meet the
 * screen. Amber everywhere: the one colour that means "the agent is
 * waiting on a person" across the dashboard's approval surfaces.
 */
export const DesktopAskLine = ({
  reason,
  tone = "dark",
  className,
}: {
  reason: string;
  /** `dark` on the scrim and the card; `light` on a light surface. */
  tone?: "dark" | "light";
  className?: string;
}) => (
  <p
    className={cn(
      "flex min-w-0 items-center gap-1.5 text-sm",
      tone === "dark" ? "text-amber-200" : "text-amber-800",
      className,
    )}
  >
    <CircleAlert className="size-3.5 shrink-0" aria-hidden />
    <span className="truncate">
      <span className="font-medium">Needs you:</span> {reason}
    </span>
  </p>
);
