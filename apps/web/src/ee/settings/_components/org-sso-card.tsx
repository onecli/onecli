"use client";

import { Card, CardContent } from "@onecli/ui/components/card";
import { useSsoConnections } from "@/hooks/use-sso-connections";
import { SsoSetupForm } from "./sso-setup-form";
import { SsoConnectionDetails } from "./sso-connection-details";

export const OrgSsoCard = () => {
  const { data: connections = [], isPending } = useSsoConnections();
  const connection = connections[0];

  return (
    <Card>
      <CardContent className="space-y-5">
        {isPending ? (
          <p className="text-muted-foreground text-sm">
            Loading SSO configuration...
          </p>
        ) : connection ? (
          <SsoConnectionDetails connection={connection} />
        ) : (
          <SsoSetupForm />
        )}
      </CardContent>
    </Card>
  );
};
