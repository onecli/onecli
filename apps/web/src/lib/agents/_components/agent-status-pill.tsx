"use client";

import { Activity, CircleCheck, CircleMinus } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
import type { HostedAvailability } from "@/lib/agents/availability";

/**
 * The one agent-status element (§3.18 rule 1): rendered identically on the
 * agent card and the chat header, agent vocabulary only. A span, not a
 * disabled button, so it stays in the a11y tree with its label — same
 * rationale as the agents page's effective-access pill.
 *
 * `loading` and `absent` render nothing: loading must never read as
 * unavailable, and where no hosted surface exists there is no status to show.
 *
 * `workingInBackground` (step 13's held-awake signal) folds into the SAME
 * element — one status per row, never a second chip: an online agent whose
 * computer is staying up to watch background work reads "Working" instead of
 * "Online". Offline wins over it — a runner that isn't reporting is the
 * truth a user must see first.
 */
const STATUS_META = {
  ready: {
    label: "Online",
    icon: CircleCheck,
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  working: {
    label: "Working",
    icon: Activity,
    className: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  offline: {
    label: "Offline",
    icon: CircleMinus,
    className: "bg-muted text-muted-foreground",
  },
} as const;

export const AgentStatusPill = ({
  availability,
  workingInBackground = false,
  className,
}: {
  availability: HostedAvailability;
  /** Live background work is holding this agent's computer up right now. */
  workingInBackground?: boolean;
  className?: string;
}) => {
  if (availability !== "ready" && availability !== "offline") return null;
  const state =
    availability === "ready" && workingInBackground ? "working" : availability;
  const meta = STATUS_META[state];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        meta.className,
        className,
      )}
      title={
        state === "working"
          ? "This agent is working in the background right now."
          : undefined
      }
    >
      <Icon className="size-3" aria-hidden />
      {meta.label}
    </span>
  );
};
