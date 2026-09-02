"use client";

import { useState } from "react";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { isPlanAtLeast, type Plan } from "@onecli/api/ee/billing/plans";
import { useGuardedUpgrade } from "@/ee/billing/use-guarded-upgrade";
import { PlanSwitchDialog } from "@/ee/billing/_components/plan-switch-dialog";
import { useWorkspaceAccess } from "@/hooks/use-workspace-access";
import { usePlanGate } from "@/lib/plan-gate";
import { WorkspaceAccessDialog } from "./workspace-access-dialog";

interface WorkspaceAccessCardProps {
  workspaceId: string;
  plan: Plan;
}

/**
 * Workspace settings → who can use this workspace. Team plan unlocks people
 * sharing; group sharing is enterprise (gated inside the dialog). Below team,
 * this keeps the upgrade CTA the old "Share workspace" card showed.
 */
export const WorkspaceAccessCard = ({
  workspaceId,
  plan,
}: WorkspaceAccessCardProps) => {
  const isTeam = isPlanAtLeast(plan, "team");
  // Sharing is enterprise-licensed on self-host: an unlicensed deployment
  // reports the top plan (no billing), so `isTeam` alone would open the dialog
  // and its /access + /members fetches would 403 off the API's
  // requireEnterprise gate. Locked → suppress the fetch, open the license
  // dialog from the button instead.
  const planGate = usePlanGate();
  const sharingLocked = planGate.isLocked("workspace_sharing");
  const {
    startUpgrade,
    checkoutLoading,
    switchTo,
    switchInterval,
    closeSwitchDialog,
  } = useGuardedUpgrade(plan);
  const [manageOpen, setManageOpen] = useState(false);
  const { data, isPending, isError } = useWorkspaceAccess(
    workspaceId,
    isTeam && !sharingLocked,
  );

  const sharedPeople = (data?.users ?? []).filter((u) => !u.isOwner).length;
  const sharedGroups = (data?.groups ?? []).length;
  const summary =
    sharedPeople === 0 && sharedGroups === 0
      ? "Not shared yet"
      : [
          sharedPeople > 0 &&
            `${sharedPeople} ${sharedPeople === 1 ? "person" : "people"}`,
          sharedGroups > 0 &&
            `${sharedGroups} ${sharedGroups === 1 ? "group" : "groups"}`,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <>
      <Card className="p-6">
        <div className="flex flex-col gap-4">
          <div>
            <h3 className="text-base font-semibold">Workspace access</h3>
            <p className="text-muted-foreground text-sm">
              {isTeam || sharingLocked
                ? "Share this workspace with teammates and groups. Members can use it; owners and org admins can also manage it."
                : "Upgrade to the Team plan to share this workspace with your teammates."}
            </p>
          </div>
          <div className="flex items-center justify-between gap-4">
            {/* The license branch outranks the plan branch: this page derives
                `plan` straight from subscriptionStatus (null on self-host →
                "free"), so `isTeam` alone would render the cloud upgrade CTA
                on an unlicensed self-host — a Stripe flow that doesn't exist
                there. Locked → license message + the guarded button. */}
            {sharingLocked ? (
              <>
                <p className="text-muted-foreground text-sm">
                  Requires a OneCLI Enterprise license
                </p>
                <Button
                  variant="outline"
                  onClick={() => planGate.guard("workspace_sharing")}
                >
                  Manage access
                </Button>
              </>
            ) : isTeam ? (
              <>
                {isPending ? (
                  <div className="bg-muted h-4 w-24 animate-pulse rounded" />
                ) : (
                  <p className="text-muted-foreground text-sm">
                    {isError ? "Couldn't load sharing" : summary}
                  </p>
                )}
                <Button variant="outline" onClick={() => setManageOpen(true)}>
                  Manage access
                </Button>
              </>
            ) : (
              <Button
                className="ml-auto"
                disabled={checkoutLoading}
                loading={checkoutLoading}
                onClick={() => startUpgrade("team")}
              >
                {checkoutLoading ? "Redirecting..." : "Upgrade to Team"}
              </Button>
            )}
          </div>
        </div>
      </Card>

      {isTeam && !sharingLocked && (
        <WorkspaceAccessDialog
          workspaceId={workspaceId}
          open={manageOpen}
          onOpenChange={setManageOpen}
        />
      )}
      <PlanSwitchDialog
        plan={switchTo}
        initialInterval={switchInterval}
        onClose={closeSwitchDialog}
      />
    </>
  );
};
