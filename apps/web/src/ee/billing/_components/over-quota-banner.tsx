"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { generateOrgPrefix } from "@/lib/org-navigation";
import { getPlanConfig, normalizePlan } from "@onecli/api/ee/billing/plans";
import {
  usePlanUsage,
  isFlaggedOverLimit,
  QUOTA_WARNING_THRESHOLD,
} from "../use-plan-usage";

export const OverQuotaBanner = () => {
  const pathname = usePathname();
  const usage = usePlanUsage();
  const orgPrefix = generateOrgPrefix(usage?.organizationId);

  if (pathname.includes("/billing")) return null;

  // Paid orgs over a grandfathered hard cap (agents, seats) are an accepted
  // state — see isFlaggedOverLimit for the rationale.
  const overResources =
    usage?.resources.filter((r) => isFlaggedOverLimit(r, usage.plan)) ?? [];

  const approachingResources =
    usage?.resources.filter(
      (r) =>
        r.name === "Integration calls" &&
        r.limit !== Infinity &&
        r.limit > 0 &&
        r.current <= r.limit &&
        r.current >= r.limit * QUOTA_WARNING_THRESHOLD,
    ) ?? [];

  if (overResources.length === 0 && approachingResources.length === 0)
    return null;

  const isOver = overResources.length > 0;
  const resources = isOver ? overResources : approachingResources;
  return (
    <Link
      href={`${orgPrefix}/billing`}
      className={`group mb-6 flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors ${
        isOver
          ? "border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/15 dark:border-amber-500/40 dark:bg-amber-500/15 dark:hover:bg-amber-500/20"
          : "border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/10 dark:border-amber-500/30 dark:bg-amber-500/10 dark:hover:bg-amber-500/15"
      }`}
    >
      <AlertTriangle className="size-4 shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {isOver ? "Over plan limits" : "Approaching plan limits"}
        </p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          You&apos;re using{" "}
          {resources.map((r, i) => (
            <span key={r.name}>
              {i > 0 && ", "}
              <strong className="text-foreground font-medium tabular-nums">
                {r.current}
              </strong>
              /{r.limit} {r.name.toLowerCase()}
            </span>
          ))}{" "}
          on the {getPlanConfig(normalizePlan(usage?.plan ?? "")).name} plan.
        </p>
      </div>
      <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-amber-600 transition-colors group-hover:text-amber-500 dark:text-amber-400 dark:group-hover:text-amber-300">
        Upgrade
        <ArrowUpRight className="size-3.5 transition-transform group-hover:-translate-y-px group-hover:translate-x-px" />
      </span>
    </Link>
  );
};
