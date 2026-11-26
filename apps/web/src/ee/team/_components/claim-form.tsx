"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useClaimProvision } from "@/hooks/use-provisions";
import { orgLanding } from "@/lib/dashboard/landing";
import { ClaimHero } from "./claim-hero";

export interface ClaimFormProps {
  token: string;
  orgName: string;
}

export const ClaimForm = ({ token, orgName }: ClaimFormProps) => {
  const router = useRouter();
  const claimProvision = useClaimProvision();
  const pending = claimProvision.isPending;

  const handleClaim = () => {
    claimProvision.mutate(token, {
      onSuccess: async (result) => {
        toast.success(`You have joined ${result.organizationName}`);
        // A full navigation, not a router push: the dashboard's server
        // components have already rendered without this membership. Land in
        // the org that was just joined, on its first agent, looked up now
        // (the workspace page sets the default-org cookie): "/" would route
        // to the user's previous default org.
        window.location.assign(await orgLanding(result.organizationId));
      },
    });
  };

  const handleDecline = () => {
    router.push("/");
  };

  return (
    <ClaimHero
      title={orgName}
      subtitle="An account has been provisioned for you. Claim it to join the team."
    >
      <div className="flex items-center justify-center gap-3">
        <Button variant="outline" onClick={handleDecline} disabled={pending}>
          Decline
        </Button>
        <Button onClick={handleClaim} loading={pending}>
          {pending ? (
            "Claiming..."
          ) : (
            <>
              <CheckCircle2 className="size-4" />
              Claim account
            </>
          )}
        </Button>
      </div>
    </ClaimHero>
  );
};
