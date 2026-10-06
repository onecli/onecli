"use client";

import { ConnectedTab } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/connected-tab";
import { useOrgConnectionsPath } from "@/lib/org-navigation";
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
  const basePath = useOrgConnectionsPath();

  return (
    <ConnectedTab
      getSecrets={getOrgSecrets}
      basePath={basePath}
      secretActions={orgSecretActions}
      pageScope="organization"
    />
  );
};
