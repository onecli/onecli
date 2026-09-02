"use client";

import { type ComponentProps } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useGuardedUpgrade } from "../use-guarded-upgrade";
import { PlanSwitchDialog } from "./plan-switch-dialog";

interface UpgradeToTeamButtonProps {
  label?: string;
  size?: ComponentProps<typeof Button>["size"];
  className?: string;
}

/**
 * Shared "Upgrade to Team" CTA. Free orgs go straight to Stripe Checkout;
 * paid orgs get the proration-preview confirm dialog first.
 */
export const UpgradeToTeamButton = ({
  label = "Upgrade to Team",
  size = "sm",
  className,
}: UpgradeToTeamButtonProps) => {
  const {
    startUpgrade,
    checkoutLoading,
    switchTo,
    switchInterval,
    closeSwitchDialog,
  } = useGuardedUpgrade();

  return (
    <>
      <Button
        size={size}
        variant="brand"
        className={className}
        loading={checkoutLoading}
        onClick={() => startUpgrade("team")}
      >
        {checkoutLoading ? "Redirecting..." : label}
        {!checkoutLoading && <ArrowRight className="size-3.5" />}
      </Button>
      <PlanSwitchDialog
        plan={switchTo}
        initialInterval={switchInterval}
        onClose={closeSwitchDialog}
      />
    </>
  );
};
