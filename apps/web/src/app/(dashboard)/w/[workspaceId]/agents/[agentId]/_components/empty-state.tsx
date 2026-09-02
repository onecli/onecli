"use client";

import type { LucideIcon } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";

/**
 * The agent page's one empty/notice frame — centered icon-circle, title,
 * description, optional action. Every screen that has nothing to show shares
 * it (agent not found, section unavailable, conversation gone, stream error,
 * hosting absent), so the visual decision lives once.
 *
 * `tone="quiet"` is the low-key variant: a single muted line for the states
 * that are honest rather than wrong — a deep link into a section this
 * deployment or this agent simply doesn't have.
 */
export const EmptyState = ({
  icon: Icon,
  title,
  description,
  action,
  tone = "default",
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  tone?: "default" | "quiet";
}) => (
  <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
    {Icon && (
      <div className="bg-muted flex size-12 items-center justify-center rounded-full">
        <Icon className="text-muted-foreground size-6" aria-hidden />
      </div>
    )}
    <div className="text-center">
      <p
        className={cn(
          "text-sm",
          tone === "quiet" ? "text-muted-foreground" : "font-medium",
        )}
      >
        {title}
      </p>
      {description && (
        <p className="text-muted-foreground mx-auto mt-1 max-w-xs text-xs">
          {description}
        </p>
      )}
    </div>
    {action}
  </div>
);
