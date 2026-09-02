"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { extractOrgId, generateOrgPrefix } from "@/lib/org-navigation";
import { getUserOrgRole } from "@/ee/team/actions";
import type { OrgRole } from "@onecli/api/ee/services/authorization-service";
import { getPlanConfig, normalizePlan } from "@onecli/api/ee/billing/plans";
import { usePlanUsage, isFlaggedOverLimit } from "../use-plan-usage";

const PLAN_STYLES: Record<string, string> = {
  free: "border-border bg-muted text-muted-foreground hover:bg-accent hover:text-foreground",
  pro: "border-brand/30 bg-brand/10 text-brand hover:bg-brand/20",
  team: "border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-400 hover:bg-purple-500/20",
  "team-legacy":
    "border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-400 hover:bg-purple-500/20",
  scale:
    "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400 hover:bg-sky-500/20",
  enterprise:
    "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20",
};

const isAdmin = (role: OrgRole) => role === "owner" || role === "admin";

export const PlanBadge = () => {
  const pathname = usePathname();
  const orgId = extractOrgId(pathname);
  const usage = usePlanUsage();
  const [role, setRole] = useState<OrgRole>("member");

  useEffect(() => {
    getUserOrgRole()
      .then(setRole)
      .catch(() => {});
  }, [orgId]);

  if (!usage)
    return (
      <Skeleton className="h-5 w-12 rounded-full bg-muted-foreground/10" />
    );

  const orgPrefix = generateOrgPrefix(usage.organizationId);
  const plan = usage.plan;
  // Paid orgs over a grandfathered hard cap (agents, seats) are an accepted
  // state — see isFlaggedOverLimit for the rationale.
  const isOverLimit = usage.resources.some((r) => isFlaggedOverLimit(r, plan));

  if (isOverLimit && isAdmin(role)) {
    return (
      <Link
        href={`${orgPrefix}/billing`}
        className="group flex items-center gap-1 rounded-full border border-brand/30 bg-brand/10 px-2.5 py-0.5 text-[11px] font-medium text-brand transition-colors hover:bg-brand/20"
      >
        Upgrade
        <ArrowUpRight className="size-3 transition-transform group-hover:-translate-y-px group-hover:translate-x-px" />
      </Link>
    );
  }

  const badgeStyle = `rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none ${PLAN_STYLES[plan] ?? PLAN_STYLES.free}`;
  // Display name from the catalog — the raw id would render "team-legacy".
  const planName = getPlanConfig(normalizePlan(plan)).name;

  if (isAdmin(role)) {
    return (
      <Link
        href={`${orgPrefix}/billing`}
        className={`${badgeStyle} transition-colors`}
      >
        {planName}
      </Link>
    );
  }

  return <span className={badgeStyle}>{planName}</span>;
};
