"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { getApp } from "@onecli/api/apps/registry";
import { ConnectFlow } from "@/app/(connect)/app-connect/_components/connect-flow";
import { ConnectLayout } from "@/app/(connect)/app-connect/_components/connect-layout";
import { getAwsExternalId } from "@/lib/actions/aws-external-id";
import { AwsTrustPolicyInfo } from "./aws-trust-policy-info";

const app = getApp("aws-role")!;

const AwsRoleConnectPage = () => {
  const searchParams = useSearchParams();
  const orgId = searchParams.get("orgId");
  const [externalId, setExternalId] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!orgId) {
      setError(true);
      return;
    }
    getAwsExternalId(orgId)
      .then(setExternalId)
      .catch(() => setError(true));
  }, [orgId]);

  if (!externalId && !error) {
    return (
      <ConnectLayout
        appName={app.name}
        appIcon={app.icon}
        appDarkIcon={app.darkIcon}
      >
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      </ConnectLayout>
    );
  }

  return (
    <ConnectFlow
      app={{
        id: app.id,
        name: app.name,
        icon: app.icon,
        darkIcon: app.darkIcon,
        connectionType: app.connectionMethod.type,
        fields:
          app.connectionMethod.type === "credentials_import"
            ? app.connectionMethod.fields
            : undefined,
      }}
      hasDefaults={true}
      preContent={
        <AwsTrustPolicyInfo
          externalId={externalId}
          loading={!externalId && !error}
        />
      }
      hiddenFields={externalId ? { externalId } : undefined}
    />
  );
};

export default AwsRoleConnectPage;
