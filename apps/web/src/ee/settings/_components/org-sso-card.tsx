"use client";

import { useState } from "react";
import { IdCard, Plus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Card, CardContent } from "@onecli/ui/components/card";
import { useSsoConnections } from "@/hooks/use-sso-connections";
import { AddIdentityProviderDialog } from "./add-identity-provider-dialog";
import { SsoConnectionDetails } from "./sso-connection-details";
import { SsoPanelHeader } from "./sso-panel";

export const OrgSsoCard = () => {
  const { data: connections = [], isPending } = useSsoConnections();
  const connection = connections[0];
  const [adding, setAdding] = useState(false);

  return (
    <Card>
      <CardContent className="space-y-5">
        <SsoPanelHeader
          icon={IdCard}
          title="Identity provider"
          description="Connect your SAML or OIDC provider so your team signs in with their company accounts."
        />
        {isPending ? (
          <p className="text-muted-foreground text-sm">
            Loading SSO configuration...
          </p>
        ) : connection ? (
          <SsoConnectionDetails connection={connection} />
        ) : (
          <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-6 py-10 text-center">
            <IdCard className="text-muted-foreground mb-1 size-5" />
            <p className="text-sm font-medium">No identity provider yet</p>
            <p className="text-muted-foreground text-sm">
              Connect Okta, Entra ID, Google Workspace, or any SAML or OIDC
              provider.
            </p>
            <Button size="sm" className="mt-3" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" aria-hidden />
              Add identity provider
            </Button>
          </div>
        )}
      </CardContent>
      <AddIdentityProviderDialog open={adding} onOpenChange={setAdding} />
    </Card>
  );
};
