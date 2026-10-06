"use client";

import { ConnectionsTabs } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/connections-tabs";
import { useOrgConnectionsPath } from "@/lib/org-navigation";
import { getOrgSecrets } from "@/lib/actions/org-secrets";

export const GlobalConnectionsTabs = () => {
  const basePath = useOrgConnectionsPath();

  return (
    <ConnectionsTabs
      getSecrets={getOrgSecrets}
      showVaults={false}
      basePath={basePath}
      pageScope="organization"
    />
  );
};
