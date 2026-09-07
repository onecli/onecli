"use client";

// Confirmation step of the AWS Marketplace registration flow: an org admin
// clicks once to link the parked subscription token to their organization.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@onecli/ui/components/button";
import {
  completeMarketplaceRegistration,
  type RegistrationResult,
} from "@/ee/billing/aws-marketplace/actions";

export function RegisterForm({
  initialError,
}: {
  initialError: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<RegistrationResult | null>(null);

  const error = result && !result.ok ? result.error : initialError;

  if (result?.ok) {
    const active = result.status === "subscribed";
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-8 text-center">
        <h1 className="text-2xl font-semibold">
          {active ? "You're all set" : "Almost there"}
        </h1>
        <p className="text-muted-foreground">
          {active ? (
            <>
              Your AWS Marketplace subscription is active
              {typeof result.entitledAgents === "number" &&
              result.entitledAgents > 0
                ? ` with ${result.entitledAgents} agents included`
                : ""}
              . Billing runs through your AWS account.
            </>
          ) : (
            <>
              Your organization is linked. AWS is still confirming the purchase;
              your plan activates automatically once it does (usually within a
              few minutes).
            </>
          )}
        </p>
        <Button onClick={() => router.push("/")}>Go to dashboard</Button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">
        Complete your AWS Marketplace setup
      </h1>
      <p className="text-muted-foreground">
        Link your AWS Marketplace subscription to this organization. Your OneCLI
        plan will be billed through AWS.
      </p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button
        disabled={pending || !!initialError}
        onClick={() =>
          startTransition(async () => {
            setResult(await completeMarketplaceRegistration());
          })
        }
      >
        {pending ? "Linking…" : "Activate subscription"}
      </Button>
    </main>
  );
}
