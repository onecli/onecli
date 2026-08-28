"use client";

import { Button } from "@onecli/ui/components/button";
import { useGuardedUpgrade } from "@/ee/billing/use-guarded-upgrade";
import { PlanSwitchDialog } from "@/ee/billing/_components/plan-switch-dialog";

export const TeamUpgradeBanner = () => {
  const {
    startUpgrade,
    checkoutLoading,
    switchTo,
    switchInterval,
    closeSwitchDialog,
  } = useGuardedUpgrade();

  return (
    <>
      <div className="bg-muted/50 flex items-center justify-between rounded-lg border px-4 py-3">
        <p className="text-muted-foreground text-sm">
          Your team is growing! Upgrade to the Team plan for advanced roles,
          <br />
          30-day audit logs, and unlimited workspaces.
        </p>
        <Button
          size="sm"
          className="shrink-0"
          loading={checkoutLoading}
          onClick={() => startUpgrade("team")}
        >
          {checkoutLoading ? "Redirecting..." : "Upgrade to Team"}
        </Button>
      </div>

      <PlanSwitchDialog
        plan={switchTo}
        initialInterval={switchInterval}
        onClose={closeSwitchDialog}
      />
    </>
  );
};
