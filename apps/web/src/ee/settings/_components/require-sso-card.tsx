"use client";

import { useState } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@onecli/ui/components/card";
import { Label } from "@onecli/ui/components/label";
import { Switch } from "@onecli/ui/components/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@onecli/ui/components/alert-dialog";
import {
  useSsoEnforcement,
  useUpdateSsoEnforcement,
} from "@/hooks/use-sso-enforcement";
import { usePlanGate } from "@/lib/plan-gate";
import { SsoPanelHeader } from "./sso-panel";

/**
 * The "Require single sign-on" org policy toggle. Enabling is confirmed via
 * a dialog with explicit lockout warnings — once on, every non-exempt
 * member's session must arrive through the org's IdP.
 */
export const RequireSsoCard = () => {
  const { data, isPending } = useSsoEnforcement();
  const updateMutation = useUpdateSsoEnforcement();
  const planGate = usePlanGate();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const locked = planGate.isLocked("sso");
  const enforced = data?.ssoRequired ?? false;
  const canRequire = data?.canRequire ?? false;
  const exemptCount = data?.exemptMemberCount ?? 0;
  const busy = isPending || updateMutation.isPending;

  // When the plan locks the feature, the switch stays interactive so the
  // click opens the contact-sales paywall (guard below) — the same behavior
  // as the plan-gated submit buttons.
  const switchDisabled = busy || (!locked && !enforced && !canRequire);

  const missingPrecondition = !data
    ? null
    : !data.hasVerifiedDomain
      ? "Verify your company domain first."
      : !data.hasActiveConnection
        ? "Complete a first sign-in through your IdP so the connection becomes active."
        : null;

  const handleToggle = (next: boolean) => {
    if (next) {
      // Only ENABLING is plan-gated — a downgraded org must always be able
      // to turn enforcement off (mirrors the server rule).
      if (planGate.guard("sso")) return;
      setConfirmOpen(true);
      return;
    }
    updateMutation.mutate(false);
  };

  return (
    <>
      <Card>
        <CardContent className="space-y-4">
          <SsoPanelHeader
            icon={ShieldCheck}
            title="Enforcement"
            description="Require members to sign in through your identity provider."
          />
          <div className="flex items-start justify-between gap-4">
            <div className="grid gap-1">
              <Label
                htmlFor="require-sso"
                className="flex items-center gap-1.5"
              >
                {locked && <Lock className="size-3.5" />}
                Require single sign-on
              </Label>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Everyone on your verified domain signs in through your IdP.
                Break-glass members keep their other sign-in methods.
              </p>
            </div>
            <Switch
              id="require-sso"
              checked={enforced}
              onCheckedChange={handleToggle}
              disabled={switchDisabled}
              aria-label="Require single sign-on"
              className="mt-0.5"
            />
          </div>
          {!enforced && !locked && missingPrecondition && (
            <p
              aria-live="polite"
              className="bg-muted text-muted-foreground rounded-md px-3 py-2 text-xs leading-relaxed"
            >
              To turn this on: {missingPrecondition}
            </p>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Require single sign-on?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  From the next sign-in on, every member with an email on your
                  verified domain must log in through your identity provider.
                  Email codes and Google sign-in will be rejected for them.
                </p>
                {exemptCount === 0 ? (
                  <p className="text-destructive font-medium">
                    No member is break-glass exempt yet. Exempt at least one
                    owner in Settings &gt; Members first. Otherwise an identity
                    provider outage can lock out the entire organization,
                    including you.
                  </p>
                ) : (
                  <p>
                    {exemptCount} break-glass{" "}
                    {exemptCount === 1 ? "member keeps" : "members keep"} their
                    other sign-in methods.
                  </p>
                )}
                <p>
                  If your own login isn&apos;t through SSO, exempt yourself
                  first or your next sign-in will be blocked.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={updateMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={updateMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                updateMutation.mutate(true, {
                  onSuccess: () => setConfirmOpen(false),
                });
              }}
            >
              {updateMutation.isPending ? "Enabling..." : "Require SSO"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
