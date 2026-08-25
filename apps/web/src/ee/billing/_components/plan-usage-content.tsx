"use client";

import Link from "next/link";
import { ArrowRight, Infinity as InfinityIcon } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import { useOrgPrefix } from "@/lib/org-navigation";
import { getPlanConfig, normalizePlan } from "@onecli/api/ee/billing/plans";
import type { UsageOverview } from "@/ee/billing/api-request-actions";

const RING_SIZE = 44;
const RING_STROKE = 3.5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const formatLimit = (limit: number) =>
  limit === Infinity ? "Unlimited" : limit.toLocaleString("en-US");

const pct = (current: number, limit: number) =>
  limit === Infinity || limit === 0
    ? 0
    : Math.min((current / limit) * 100, 100);

const UsageRing = ({
  percentage,
  atLimit,
  unlimited,
}: {
  percentage: number;
  atLimit: boolean;
  unlimited: boolean;
}) => {
  if (unlimited) {
    return (
      <div className="flex size-11 items-center justify-center rounded-full border border-dashed border-muted-foreground/25">
        <InfinityIcon className="text-muted-foreground/50 size-4" />
      </div>
    );
  }

  const offset = RING_CIRCUMFERENCE - (percentage / 100) * RING_CIRCUMFERENCE;

  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      className="shrink-0 -rotate-90"
    >
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        className="text-muted-foreground/15"
        strokeWidth={RING_STROKE}
      />
      {percentage > 0 && (
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          className={atLimit ? "text-amber-500" : "text-brand"}
          stroke="currentColor"
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.5s ease" }}
        />
      )}
    </svg>
  );
};

export const PlanUsageContent = ({ data }: { data: UsageOverview }) => {
  const orgPrefix = useOrgPrefix();
  const hasLimitedResource = data.resources.some((r) => r.limit !== Infinity);
  const anyAtLimit = data.resources.some(
    (r) => r.limit !== Infinity && r.current >= r.limit,
  );

  return (
    <div className="overflow-hidden rounded-xl border">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 border-b px-5 py-3">
        <p className="text-muted-foreground text-sm">
          <span className="text-foreground font-medium">
            {getPlanConfig(normalizePlan(data.plan)).name}
          </span>{" "}
          plan {anyAtLimit ? "- quota limit reached" : "usage"}
        </p>
        {hasLimitedResource && (
          <Button variant="outline" size="sm" className="shrink-0" asChild>
            <Link href={`${orgPrefix}/billing`}>
              Upgrade
              <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        )}
      </div>

      {/* 2-column usage grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2">
        {data.resources.map((resource, i) => {
          const totalItems = data.resources.length;
          const isLastRow = i >= totalItems - (totalItems % 2 === 0 ? 2 : 1);
          const percentage = pct(resource.current, resource.limit);
          const atLimit =
            resource.limit !== Infinity && resource.current >= resource.limit;
          const unlimited = resource.limit === Infinity;

          return (
            <div
              key={resource.name}
              className={cn(
                "flex items-center justify-between gap-4 px-5 py-4",
                !isLastRow && "border-b",
                i % 2 === 0 && "sm:border-r",
              )}
            >
              <div className="min-w-0">
                <p className="text-foreground text-sm font-medium">
                  {resource.name}
                </p>
                <p
                  className={cn(
                    "mt-0.5 text-[13px] tabular-nums",
                    atLimit
                      ? "text-amber-500 font-medium"
                      : "text-muted-foreground",
                  )}
                >
                  {resource.current} / {formatLimit(resource.limit)}
                </p>
              </div>
              <UsageRing
                percentage={percentage}
                atLimit={atLimit}
                unlimited={unlimited}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};
