"use client";

import { Activity, CircleMinus } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
import type { HostedAvailability } from "@/lib/agents/availability";

/**
 * The one agent-status element (§3.18 rule 1): rendered identically on the
 * agent card and the chat header, agent vocabulary only. A span, not a
 * disabled button, so it stays in the a11y tree with its label — same
 * rationale as the agents page's effective-access pill.
 *
 * It shows only what a user must act on or know: `working` (step 13's
 * held-awake signal: live background work is keeping the agent's computer
 * up) and `offline` (the deployment's agents cannot run), offline winning —
 * a runner that isn't reporting is the truth a user must see first.
 * Everything else renders nothing: `loading` must never read as
 * unavailable, `absent` has no hosted surface, and idle-and-online is the
 * normal state (deployment-wide, not this agent's), so a green "Online"
 * told the user nothing and kept reading "Online" through an agent restart.
 */
const STATUS_META = {
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

type AgentStatus = keyof typeof STATUS_META;

/** The status worth showing, or null when there is none — the one rule
 * every status surface (the pill, the Details row) reads. */
export const agentStatus = (
  availability: HostedAvailability,
  workingInBackground = false,
): AgentStatus | null => {
  if (availability === "offline") return "offline";
  if (availability === "ready" && workingInBackground) return "working";
  return null;
};

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
  const state = agentStatus(availability, workingInBackground);
  if (!state) return null;
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
