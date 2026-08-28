"use client";

import { AppsTab } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/apps-tab";
import { useOrgPrefix } from "@/lib/org-navigation";

export const GlobalAppsPage = () => {
  const orgPrefix = useOrgPrefix();

  return (
    <AppsTab
      pageScope="organization"
      basePath={`${orgPrefix}/global-connections`}
    />
  );
};
