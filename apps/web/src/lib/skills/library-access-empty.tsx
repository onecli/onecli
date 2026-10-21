"use client";

import Link from "next/link";
import { Button } from "@onecli/ui/components/button";
import { GitHubMark } from "./github-mark";

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
 * organization first and come back to pick it.
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
          Connect GitHub to the organization first, then pick it here.
        </p>
        {orgId && (
          <Button asChild variant="outline">
            <Link
              href={`/org/${encodeURIComponent(orgId)}/settings/global-connections`}
            >
              Go to Shared Connections
            </Link>
          </Button>
        )}
      </>
    )}
  </div>
);
