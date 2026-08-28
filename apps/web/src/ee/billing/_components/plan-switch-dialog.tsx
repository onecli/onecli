"use client";

import { useEffect, useState } from "react";
import { Button } from "@onecli/ui/components/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@onecli/ui/components/alert-dialog";
import { Skeleton } from "@onecli/ui/components/skeleton";
import type { BillingInterval, PlanConfig } from "@onecli/api/ee/billing/plans";
import {
  usePlanSwitchPreview,
  useSwitchPlan,
} from "@/ee/billing/use-plan-switch";
import { BillingIntervalToggle } from "@/ee/billing/_components/billing-interval-toggle";
import { formatDollars, formatWholeDollars } from "@/ee/billing/format";

export interface PlanSwitchDialogProps {
  plan: PlanConfig | null;
  /** Interval preselected when the dialog opens; changeable inside. */
  initialInterval: BillingInterval;
  onClose: () => void;
}

export const PlanSwitchDialog = ({
  plan,
  initialInterval,
  onClose,
}: PlanSwitchDialogProps) => {
  const [interval, setBillingInterval] = useState(initialInterval);
  // Re-arm the preselection each time the dialog opens for a target plan.
  useEffect(() => {
    if (plan) setBillingInterval(initialInterval);
  }, [plan, initialInterval]);

  const preview = usePlanSwitchPreview(plan?.id ?? null, interval);
  const switchPlan = useSwitchPlan();
  const requiresCheckout = preview.data?.requiresCheckout ?? false;

  return (
    <AlertDialog
      open={!!plan}
      onOpenChange={(open) => {
        if (!open && !switchPlan.isPending) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Switch to {plan?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Review the charge before switching your plan.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div>
          <BillingIntervalToggle
            value={interval}
            onChange={setBillingInterval}
            disabled={switchPlan.isPending}
          />
        </div>

        <div className="text-muted-foreground text-sm">
          {preview.isPending ? (
            <div className="space-y-2">
              {/* bg-accent (the component default) is near-invisible on the
                  white/dark dialog surface in this theme */}
              <Skeleton className="bg-muted-foreground/20 h-4 w-full" />
              <Skeleton className="bg-muted-foreground/20 h-4 w-2/3" />
            </div>
          ) : preview.isError ? (
            <p className="text-destructive">
              {/* Server rejections carry the actual reason (e.g. "You're
                  already on this plan and billing interval."); show it. */}
              {preview.error instanceof Error &&
              preview.error.message &&
              !preview.error.message.startsWith("Request failed")
                ? preview.error.message
                : "Couldn't load the price preview. Close this dialog and try again."}
            </p>
          ) : preview.data?.requiresCheckout ? (
            <div className="space-y-2">
              <p>
                Your trial has no payment method on file, so you&apos;ll be
                redirected to Stripe Checkout to enter payment details.
              </p>
              <p>
                Your {plan?.name} plan starts immediately at{" "}
                <span className="text-foreground font-semibold">
                  {formatWholeDollars(preview.data.newPriceCents)}/
                  {preview.data.interval === "year" ? "year" : "month"}
                </span>
                , and your remaining trial ends.
              </p>
            </div>
          ) : preview.data ? (
            <div className="space-y-2">
              <p>
                {preview.data.trialing ? (
                  <>
                    No charge today: your trial continues on the {plan?.name}{" "}
                    plan.
                  </>
                ) : preview.data.amountDueTodayCents > 0 ? (
                  <>
                    You&apos;ll be charged{" "}
                    <span className="text-foreground font-semibold">
                      {formatDollars(preview.data.amountDueTodayCents)}
                    </span>{" "}
                    today, prorated for the rest of your current billing cycle.
                  </>
                ) : preview.data.amountDueTodayCents === 0 ? (
                  <>No charge today.</>
                ) : (
                  <>
                    No charge today:{" "}
                    <span className="text-foreground font-semibold">
                      {formatDollars(
                        Math.abs(preview.data.amountDueTodayCents),
                      )}
                    </span>{" "}
                    will be applied as credit to your next invoice.
                  </>
                )}
              </p>
              <p>
                {preview.data.renewsAt ? (
                  <>
                    From{" "}
                    {new Date(preview.data.renewsAt).toLocaleDateString(
                      "en-US",
                      { month: "long", day: "numeric", year: "numeric" },
                    )}
                    , you&apos;ll pay{" "}
                    <span className="text-foreground font-semibold">
                      {formatWholeDollars(preview.data.newPriceCents)}/
                      {preview.data.interval === "year" ? "year" : "month"}
                    </span>
                    .
                  </>
                ) : (
                  <>
                    Your new price is{" "}
                    <span className="text-foreground font-semibold">
                      {formatWholeDollars(preview.data.newPriceCents)}/
                      {preview.data.interval === "year" ? "year" : "month"}
                    </span>
                    .
                  </>
                )}
              </p>
              {preview.data.pendingCancellationCleared && (
                <p>Your scheduled cancellation will be removed.</p>
              )}
            </div>
          ) : null}
        </div>

        <AlertDialogFooter>
          <Button
            variant="ghost"
            disabled={switchPlan.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            loading={switchPlan.isPending}
            disabled={
              preview.isPending || preview.isError || switchPlan.isPending
            }
            onClick={() => {
              if (plan && preview.data) {
                switchPlan.mutate({
                  plan: plan.id,
                  interval,
                  prorationDate: preview.data.prorationDate,
                });
              }
            }}
          >
            {switchPlan.isPending
              ? requiresCheckout
                ? "Redirecting..."
                : "Switching..."
              : requiresCheckout
                ? "Continue to Checkout"
                : "Switch Plan"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
