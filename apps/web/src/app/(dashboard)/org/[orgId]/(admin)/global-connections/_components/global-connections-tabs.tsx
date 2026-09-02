"use client";

import { ConnectionsTabs } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/connections-tabs";
import { useOrgPrefix } from "@/lib/org-navigation";
import { getOrgSecrets } from "@/lib/actions/org-secrets";

export const GlobalConnectionsTabs = () => {
  const orgPrefix = useOrgPrefix();

  return (
    <ConnectionsTabs
      getSecrets={getOrgSecrets}
      showVaults={false}
      basePath={`${orgPrefix}/global-connections`}
      pageScope="organization"
    />
  );
};
