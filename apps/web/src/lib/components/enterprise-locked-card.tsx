import { Lock } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  ENTERPRISE_FEATURES,
  type EnterpriseFeature,
} from "@onecli/api/lib/entitlements";

export interface EnterpriseLockedCardProps {
  feature: EnterpriseFeature;
  /** One sentence on what the locked page/section does. */
  description: string;
}

/**
 * The full-surface locked state for an enterprise page on an unlicensed
 * self-host instance. Rendered INSTEAD of the page's data (the decided
 * posture: the EE surface is dark without a license — pages fetch nothing).
 * Server-component-safe: no hooks, no client APIs.
 */
export const EnterpriseLockedCard = ({
  feature,
  description,
}: EnterpriseLockedCardProps) => (
  <div className="flex min-h-[50svh] items-center justify-center">
    <div className="flex max-w-sm flex-col items-center text-center">
      <div className="bg-card flex size-14 items-center justify-center rounded-2xl border shadow-sm">
        <Lock aria-hidden="true" className="text-muted-foreground size-6" />
      </div>
      <h2 className="mt-4 text-base font-semibold">
        {ENTERPRISE_FEATURES[feature]}
      </h2>
      <span className="text-muted-foreground mt-1 inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium">
        Enterprise
      </span>
      <p className="text-muted-foreground mt-3 text-sm">
        {description} Available with a OneCLI Enterprise license.
      </p>
      <Button asChild className="mt-6">
        <a
          href="https://onecli.sh/pricing"
          target="_blank"
          rel="noopener noreferrer"
        >
          Learn about OneCLI Enterprise
        </a>
      </Button>
    </div>
  </div>
);
