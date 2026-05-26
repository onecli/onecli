import { Ban, ShieldCheck, Timer } from "lucide-react";

interface StatusBadgeProps {
  status: number;
  blocked?: boolean;
  defaultDenied?: boolean;
  rateLimited?: boolean;
}

export const StatusBadge = ({
  status,
  blocked,
  defaultDenied,
  rateLimited,
}: StatusBadgeProps) => {
  if (defaultDenied) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
        <ShieldCheck className="size-3 shrink-0" />
        Not allowed
      </span>
    );
  }

  if (blocked) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
        <Ban className="size-3 shrink-0" />
        Blocked
      </span>
    );
  }

  if (rateLimited) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400">
        <Timer className="size-3 shrink-0" />
        Rate Limited
      </span>
    );
  }

  if (status >= 200 && status < 300) {
    return (
      <span className="text-xs font-medium text-muted-foreground tabular-nums">
        {status}
      </span>
    );
  }

  if (status >= 400 && status < 500) {
    return (
      <span className="text-xs font-medium text-foreground tabular-nums">
        {status}
      </span>
    );
  }

  if (status >= 500) {
    return (
      <span className="text-xs font-medium text-destructive tabular-nums">
        {status}
      </span>
    );
  }

  return (
    <span className="text-xs text-muted-foreground tabular-nums">{status}</span>
  );
};
