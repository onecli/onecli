"use client";

import Link from "next/link";
import { generateOrgPrefix } from "@/lib/org-navigation";
import { usePlanUsage, QUOTA_WARNING_THRESHOLD } from "../use-plan-usage";

export const IntegrationCallsWarning = () => {
  const usage = usePlanUsage();
  const orgPrefix = generateOrgPrefix(usage?.organizationId);

  const calls = usage?.resources.find((r) => r.name === "Integration calls");
  if (!calls || calls.limit === Infinity || calls.limit === 0) return null;

  const ratio = calls.current / calls.limit;
  if (ratio < QUOTA_WARNING_THRESHOLD) return null;

  const isExceeded = calls.current > calls.limit;
  const percentage = Math.min(Math.round(ratio * 100), 100);

  return (
    <Link
      href={`${orgPrefix}/billing`}
      className="group flex flex-col gap-1.5 rounded-md border px-3 py-2 transition-colors hover:bg-accent/50"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">Integration calls</span>
        <span className="text-muted-foreground text-[10px] tabular-nums">
          {calls.current.toLocaleString()}/{calls.limit.toLocaleString()}
        </span>
      </div>
      <div className="bg-muted h-1 overflow-hidden rounded-full">
        <div
          className={`h-full rounded-full transition-all ${
            isExceeded ? "bg-destructive" : "bg-amber-500"
          }`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span
        className={`text-[10px] transition-colors ${
          isExceeded
            ? "text-destructive/70 group-hover:text-destructive"
            : "text-muted-foreground group-hover:text-foreground"
        }`}
      >
        {isExceeded ? "Upgrade to restore access" : "Upgrade for unlimited"}
      </span>
    </Link>
  );
};
