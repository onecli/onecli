"use client";

import { useSearchParams } from "next/navigation";
import { getApp } from "@onecli/api/apps/registry";
import { ConnectFlow } from "@/app/(connect)/app-connect/_components/connect-flow";
import { useAwsExternalId } from "@/hooks/use-aws-external-id";
import { AwsTrustPolicyInfo } from "./aws-trust-policy-info";

const app = getApp("aws-role")!;

/**
 * AWS Role connect. Unlike a plain credentials-import app, this screen shows a
 * first step: the two values the user must put in their IAM role's trust
 * policy — our AWS account id and THEIR org's external ID.
 *
 * The external ID is display-only. It reaches the connection server-side (the
 * app's `serverFields`), never as a submitted field, because a customer-chosen
 * external ID would void the confused-deputy protection it exists for. So the
 * form stays usable even while the id is loading or failed to load: the
 * connect call fills it in regardless.
 *
 * The scope comes from the QUERY STRING, and must be threaded explicitly into
 * the read. This page's pathname is `/app-connect/aws-role`, which matches
 * neither `/w/<id>` nor `/org/<id>`, so `apiFetch`'s pathname-derived tenancy
 * headers come out empty — and a cloud session with no workspace and no org
 * resolves to no tenant at all, which 401s. The popup is opened from both the
 * workspace Connections page (`?workspaceId=`) and the org Global Connections
 * page (`?orgId=`); both must work.
 */
const AwsRoleConnectPage = () => {
  const searchParams = useSearchParams();
  const scope = {
    workspaceId: searchParams.get("workspaceId") ?? undefined,
    orgId: searchParams.get("orgId") ?? undefined,
  };
  const { data: externalId, isPending, isError } = useAwsExternalId(scope);

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
      workspaceId={scope.workspaceId}
      orgId={scope.orgId}
      preContent={
        <AwsTrustPolicyInfo
          externalId={externalId ?? null}
          loading={isPending}
          failed={isError}
        />
      }
    />
  );
};

export default AwsRoleConnectPage;
