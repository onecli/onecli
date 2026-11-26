"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@onecli/ui/components/button";
import { getApp } from "@onecli/api/apps/registry";
import { openConnectPopup } from "@/lib/connect-popup";
import { useAppMessages } from "@/hooks/use-app-connected";
import { GITHUB_APP_PROVIDER } from "@/hooks/use-github-app-share";
import { queryKeys } from "@/lib/api/keys";
import { ConfigureCredentialsDialog } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/configure-credentials-dialog";

export interface ConnectGitHubAppButtonProps {
  orgId: string;
}

const githubApp = getApp(GITHUB_APP_PROVIDER);

/**
 * Connect GitHub to the organization without leaving the skills dialog. The
 * click always opens the org-level connect popup: only the server knows
 * every place the GitHub App's credentials can come from (the org's own
 * config or the deployment's defaults), and when there are none the popup
 * asks back (`app-configure`), which opens the same setup dialog as Shared
 * Connections here and then the popup again. When the popup reports a
 * connection, the library's account list is refetched, so the dialog swaps
 * to the repo picker by itself.
 */
export const ConnectGitHubAppButton = ({
  orgId,
}: ConnectGitHubAppButtonProps) => {
  const queryClient = useQueryClient();
  const [setupOpen, setSetupOpen] = useState(false);
  const fields = githubApp?.configurable?.fields;

  const openPopup = () => openConnectPopup(GITHUB_APP_PROVIDER, { orgId });

  useAppMessages({
    onConnected: (event) => {
      if (event.provider && event.provider !== GITHUB_APP_PROVIDER) return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.skills.githubAccounts(),
      });
    },
    onConfigure: (provider) => {
      if (provider === GITHUB_APP_PROVIDER && fields) setSetupOpen(true);
    },
  });

  return (
    <>
      <Button variant="outline" onClick={openPopup}>
        Connect GitHub App
      </Button>
      {githubApp && fields && (
        <ConfigureCredentialsDialog
          provider={GITHUB_APP_PROVIDER}
          appName={githubApp.name}
          appIcon={githubApp.icon}
          appDarkIcon={githubApp.darkIcon}
          fields={fields}
          hint={githubApp.configurable?.hint}
          setupGuideUrl={githubApp.setupGuideUrl}
          open={setupOpen}
          onOpenChange={setSetupOpen}
          pageScope="organization"
          onConfigured={() => {
            setSetupOpen(false);
            openPopup();
          }}
        />
      )}
    </>
  );
};
