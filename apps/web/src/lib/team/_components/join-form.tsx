"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { BrandLogo } from "@/lib/components/brand-logo";
import { useAcceptInvitation } from "@/hooks/use-invitations";

export interface JoinFormProps {
  token: string;
  orgName: string;
  orgSlug?: string;
}

export const JoinForm = ({ token, orgName, orgSlug }: JoinFormProps) => {
  const router = useRouter();
  const acceptInvitation = useAcceptInvitation();
  const pending = acceptInvitation.isPending;

  const handleJoin = () => {
    acceptInvitation.mutate(token, {
      onSuccess: (result) => {
        toast.success(`You have joined ${result.organizationName}`);
        // A full navigation, not a router push: the dashboard's server
        // components have already rendered without this membership. Land
        // INSIDE the org they just joined, not on whatever org the default
        // cookie pointed at — the org layout re-pins the cookie on arrival.
        window.location.assign(`/org/${result.organizationId}/workspaces`);
      },
    });
  };

  const handleDecline = () => {
    router.push("/");
  };

  return (
    <div className="flex min-h-svh flex-col items-center justify-center px-4">
      <BrandLogo />

      <Card className="w-full max-w-md p-8">
        <div className="space-y-4 text-center">
          <p className="text-muted-foreground text-sm">
            You have been invited to join
          </p>
          <h1 className="text-2xl font-semibold">{orgName}</h1>
          {orgSlug && (
            <p className="text-muted-foreground text-sm">
              Organization slug: {orgSlug}
            </p>
          )}
        </div>

        <div className="mt-8 flex items-center justify-center gap-3">
          <Button variant="outline" onClick={handleDecline} disabled={pending}>
            Decline
          </Button>
          <Button onClick={handleJoin} disabled={pending}>
            {pending ? (
              "Joining..."
            ) : (
              <>
                <CheckCircle2 className="size-4" />
                Join organization
              </>
            )}
          </Button>
        </div>
      </Card>
    </div>
  );
};
