"use client";

import { Button } from "@onecli/ui/components/button";
import { GitHubMark } from "./github-mark";
import { ConnectGitHubAppButton } from "./connect-github-app-button";

export interface LibraryAccessEmptyProps {
  /** "Install GitHub for skills only" is offered (the server allows it and
   * there is an org to grant it for). */
  canInstall: boolean;
  orgId: string;
  onInstall: () => void;
}

/**
 * The connect dialog with no GitHub access to pick: install the GitHub App
 * for skills only when that is available, otherwise connect GitHub to the
 * organization right here (setup + popup), and the picker appears once it
 * lands.
 */
export const LibraryAccessEmpty = ({
  canInstall,
  orgId,
  onInstall,
}: LibraryAccessEmptyProps) => (
  <div className="flex flex-col items-center gap-3 py-6 text-center">
    <div className="bg-muted flex size-10 items-center justify-center rounded-full">
      <GitHubMark />
    </div>
    {canInstall ? (
      <>
        <p className="text-muted-foreground max-w-sm text-sm">
          Install the OneCLI GitHub App on the account that holds your skills
          repo. It&apos;s used for skills only and won&apos;t appear under
          Connections. You&apos;ll pick the repo right after.
        </p>
        <Button onClick={onInstall}>Install GitHub for skills only</Button>
      </>
    ) : (
      <>
        <p className="text-muted-foreground max-w-sm text-sm">
          Connect GitHub to the organization, then pick the repo here.
        </p>
        {orgId && <ConnectGitHubAppButton orgId={orgId} />}
      </>
    )}
  </div>
);
