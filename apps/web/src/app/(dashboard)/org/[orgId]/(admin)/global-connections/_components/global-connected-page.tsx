"use client";

import { ConnectedTab } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/connected-tab";
import { useOrgPrefix } from "@/lib/org-navigation";
import {
  getOrgSecrets,
  createOrgSecretAction,
  deleteOrgSecretAction,
  updateOrgSecretAction,
} from "@/lib/actions/org-secrets";

const orgSecretActions = {
  createSecret: createOrgSecretAction,
  deleteSecret: deleteOrgSecretAction,
  updateSecret: updateOrgSecretAction,
};

export const GlobalConnectedPage = () => {
  const orgPrefix = useOrgPrefix();

  return (
    <ConnectedTab
      getSecrets={getOrgSecrets}
      basePath={`${orgPrefix}/global-connections`}
      secretActions={orgSecretActions}
      pageScope="organization"
    />
  );
};
