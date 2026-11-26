"use client";

import { Check, Copy, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import {
  GITHUB_AUTHORIZED_APPS_URL,
  githubOrgAccessStatus,
  githubOrgAdminMessage,
  githubOrgSsoUrl,
  type GitHubOrgAccessIssue,
} from "@onecli/api/lib/github-org-access";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

export interface GitHubOrgAccessNoticeProps extends React.ComponentProps<"div"> {
  issue: GitHubOrgAccessIssue;
  /** Re-authorizes the connection. Omitted where it can't be reconnected
   * from this surface (an org-shared connection on a workspace page). */
  onReconnect?: () => void;
  /** The agent's `org_access=<org>` link pointed here. */
  highlighted?: boolean;
}

/**
 * One GitHub organization that refused the connection (recorded by the
 * gateway), with the steps that actually fix it. The account itself stays
 * connected: everything outside this organization keeps working.
 *
 * - Approval: the user requests access on GitHub (which notifies the
 *   organization's owners), and an owner grants it. "Copy message for admin"
 *   hands the user a note with the owner's exact approval page.
 * - SSO: sign in to the organization's SSO, then reconnect, because GitHub
 *   only authorizes an OAuth connection for an SSO organization when a session
 *   was active at authorization time.
 *
 * Clears on its own: the gateway drops the record on a reconnect or once the
 * refused request goes through.
 */
export const GitHubOrgAccessNotice = ({
  issue,
  onReconnect,
  highlighted = false,
  className,
  ...props
}: GitHubOrgAccessNoticeProps) => {
  const { copied, copy } = useCopyToClipboard();
  const approval = issue.reason === "approval_required";

  return (
    <div
      className={cn(
        "rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2",
        highlighted && "ring-2 ring-ring",
        className,
      )}
      {...props}
    >
      <p className="text-xs font-medium">
        <span className="break-all" translate="no">
          {issue.org}
        </span>
        <span className="text-amber-700 dark:text-amber-400">
          {" · "}
          {githubOrgAccessStatus(issue.reason)}
        </span>
      </p>
      <p className="text-muted-foreground mt-0.5 text-xs">
        {approval
          ? `${issue.org} hasn't approved OneCLI yet. Request access on GitHub, then ask an owner of ${issue.org} to approve it. Everything outside ${issue.org} keeps working.`
          : `${issue.org} requires single sign-on. Sign in to ${issue.org} SSO, then reconnect GitHub. Everything outside ${issue.org} keeps working.`}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {approval ? (
          <>
            <Button size="xs" variant="outline" asChild>
              <a
                href={GITHUB_AUTHORIZED_APPS_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink aria-hidden />
                Request Access
              </a>
            </Button>
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Copy a message asking an owner of ${issue.org} to approve OneCLI`}
              onClick={() => void copy(githubOrgAdminMessage(issue.org))}
            >
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied ? "Copied" : "Copy Message for Admin"}
            </Button>
            {/* The button's aria-label hides its visible "Copied", so the
                confirmation is announced here. */}
            <span aria-live="polite" className="sr-only">
              {copied ? "Message copied" : ""}
            </span>
          </>
        ) : (
          <>
            <Button size="xs" variant="outline" asChild>
              <a
                href={githubOrgSsoUrl(issue.org)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink aria-hidden />
                Sign In to {issue.org} SSO
              </a>
            </Button>
            {onReconnect && (
              <Button size="xs" variant="ghost" onClick={onReconnect}>
                <RefreshCw aria-hidden />
                Reconnect
              </Button>
            )}
          </>
        )}
      </div>
      {approval && (
        <p className="text-muted-foreground mt-1.5 text-[11px]">
          On GitHub: open OneCLI, then click Request access next to {issue.org}.
        </p>
      )}
    </div>
  );
};
