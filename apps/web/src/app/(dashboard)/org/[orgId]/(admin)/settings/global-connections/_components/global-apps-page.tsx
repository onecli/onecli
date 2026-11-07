"use client";

import { AppsTab } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/apps-tab";
import { useOrgConnectionsPath } from "@/lib/org-navigation";

export const GlobalAppsPage = () => {
  const basePath = useOrgConnectionsPath();

  return <AppsTab pageScope="organization" basePath={basePath} />;
};
