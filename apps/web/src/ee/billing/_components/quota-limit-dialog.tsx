"use client";

import Link from "next/link";
import { ArrowRight, Gauge } from "lucide-react";
import { useSettingsHref } from "@/lib/settings-modal/use-settings-href";
import { Button } from "@onecli/ui/components/button";
import { getPlanConfig, normalizePlan } from "@onecli/api/ee/billing/plans";
import { UpgradeDialogShell } from "@/lib/components/upgrade-dialog-shell";
import { UsageBar } from "./usage-bar";

export interface QuotaLimitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceName: string;
  current: number;
  limit: number;
  plan: string;
}

export const QuotaLimitDialog = ({
  open,
  onOpenChange,
  resourceName,
  current,
  limit,
  plan,
}: QuotaLimitDialogProps) => {
  const billingHref = useSettingsHref()("billing");
  const noun =
    limit === 1
      ? resourceName.toLowerCase().replace(/s$/, "")
      : resourceName.toLowerCase();

  return (
    <UpgradeDialogShell
      open={open}
      onOpenChange={onOpenChange}
      icon={<Gauge className="size-6 text-amber-500" />}
      title={`${resourceName} limit reached`}
      description={`Your ${getPlanConfig(normalizePlan(plan)).name} plan includes ${limit} ${noun}. Upgrade your plan to create more.`}
      footer={
        <div className="flex w-full gap-3">
          <Button
            variant="ghost"
            className="flex-1"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button variant="brand" className="flex-1" asChild>
            <Link href={billingHref} onClick={() => onOpenChange(false)}>
              Upgrade
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      }
    >
      <UsageBar
        label={`${resourceName} used`}
        current={current}
        limit={limit}
      />
    </UpgradeDialogShell>
  );
};
