"use client";

import { Lock } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { UpgradeDialogShell } from "@/lib/components/upgrade-dialog-shell";
import {
  ENTERPRISE_FEATURES,
  type EnterpriseFeature,
} from "@onecli/api/lib/entitlements";

export interface LicenseRequiredDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  feature: EnterpriseFeature;
}

/**
 * The self-host answer to the cloud paywall: a licensed feature was selected
 * on an instance without `ENTERPRISE_ENABLED`. Talks about the license, never
 * plans or billing — there is nothing to purchase in-product on self-host.
 */
export const LicenseRequiredDialog = ({
  open,
  onOpenChange,
  feature,
}: LicenseRequiredDialogProps) => (
  <UpgradeDialogShell
    open={open}
    onOpenChange={onOpenChange}
    icon={<Lock aria-hidden="true" className="text-muted-foreground size-6" />}
    title={ENTERPRISE_FEATURES[feature]}
    pill="Enterprise"
    description="This feature is part of OneCLI Enterprise and requires an Enterprise license."
    footer={
      <Button asChild className="w-full">
        <a
          href="https://onecli.sh/pricing"
          target="_blank"
          rel="noopener noreferrer"
        >
          Learn about OneCLI Enterprise
        </a>
      </Button>
    }
  />
);
