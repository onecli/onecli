"use client";

import { cn } from "@onecli/ui/lib/utils";
import { centsToUsd, type BudgetPeriod } from "@/ee/budget/budget-pricing";

const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

export interface UsageMeterProps {
  spentCents: number;
  limitCents: number;
  period: BudgetPeriod;
}

/** Spend-vs-limit bar for one budget. Green → amber (≥80%) → red (paused). */
export const UsageMeter = ({
  spentCents,
  limitCents,
  period,
}: UsageMeterProps) => {
  const spent = centsToUsd(spentCents);
  const limit = centsToUsd(limitCents);
  const pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;
  const over = limit > 0 && spent >= limit;
  const near = pct >= 80;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="flex items-baseline gap-1.5">
          <span
            className={cn(
              "text-sm font-semibold tabular-nums",
              over && "text-destructive",
            )}
          >
            {fmtUsd(spent)}
          </span>
          <span className="text-muted-foreground text-xs tabular-nums">
            / {fmtUsd(limit)}
          </span>
        </p>
        <span className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
          {period === "monthly" ? "this month" : "total"}
        </span>
      </div>

      <div
        className="bg-muted h-2 w-full overflow-hidden rounded-full"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 ease-out",
            over ? "bg-destructive" : near ? "bg-amber-500" : "bg-emerald-500",
          )}
          style={{ width: `${Math.max(pct, over ? 100 : 2)}%` }}
        />
      </div>

      {over && (
        <p className="text-destructive flex items-center gap-1.5 text-[11px] font-medium">
          <span className="bg-destructive size-1.5 rounded-full" />
          Key paused: limit reached
        </p>
      )}
    </div>
  );
};
