"use client";

import { useConnectionTestOrganization } from "@/hooks/use-connection-test-organization";
import { useOrgMembership } from "@/hooks/use-org";
import { TestConnection } from "./test-connection";

export interface InheritedTestConnectionProps {
  connectionId: string;
  hasElevatedAccess?: boolean;
}

/** Org-owned rows always require org admin scope, even on /w pages. */
export const InheritedTestConnection = ({
  connectionId,
  hasElevatedAccess,
}: InheritedTestConnectionProps) => {
  const { data: organizationId } = useConnectionTestOrganization();
  const { data: membership } = useOrgMembership();
  if (!organizationId || !membership?.isAdmin) return null;
  return (
    <TestConnection
      connectionId={connectionId}
      hasElevatedAccess={hasElevatedAccess}
      scope={{ kind: "organization", organizationId }}
    />
  );
};
