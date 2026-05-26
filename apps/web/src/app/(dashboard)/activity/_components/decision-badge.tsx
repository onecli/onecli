import type { ApprovalDecision } from "@onecli/api/services/request-log-service";

interface DecisionBadgeProps {
  decision: ApprovalDecision | null;
}

const config = {
  pending: {
    label: "Pending",
    className:
      "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400",
  },
  approved: {
    label: "Approved",
    className:
      "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400",
  },
  denied: {
    label: "Denied",
    className: "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  },
  timed_out: {
    label: "Timed Out",
    className: "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  },
  cancelled: {
    label: "Cancelled",
    className: "bg-muted text-muted-foreground",
  },
} as const;

export const DecisionBadge = ({ decision }: DecisionBadgeProps) => {
  if (!decision) return null;

  const { label, className } = config[decision];

  return (
    <span
      className={`inline-flex rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${className}`}
    >
      {label}
    </span>
  );
};
