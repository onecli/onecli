"use client";

import Image from "next/image";
import { Building2 } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Card } from "@onecli/ui/components/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import {
  extractGitHubOrgAccess,
  githubOrgAccessSummary,
} from "@onecli/api/lib/github-org-access";
import type { PageScope } from "@/lib/api";
import { connectionAccessLevelLabel } from "@onecli/api/apps/access-level";
import { connectionTags } from "@onecli/api/lib/connection-display";
import { ConnectionAgentRows } from "./connection-agent-rows";
import { GitHubOrgAccessNotice } from "./github-org-access-notice";
import type { AccountCardConnection } from "./account-card-connection";
import { accountTypeLabel } from "@/lib/connections/account-type-label";

interface InheritedConnectionCardProps {
  connection: AccountCardConnection;
  pageScope?: PageScope;
  /** The agent's `?org_access=<org>` link named this GitHub organization. */
  highlightedOrg?: string | null;
}

const metaString = (
  meta: Record<string, unknown> | null,
  key: string,
): string | undefined => {
  const value = meta?.[key];
  return typeof value === "string" ? value : undefined;
};

/**
 * An org-scoped connection on the workspace page. It is managed at the org
 * level (no rename/disconnect/reconnect here), but which of this workspace's
 * agents use it is decided right here, so it reads like any account card,
 * marked with an Org badge instead of looking disabled. GitHub organizations
 * that refused it are shown too, without Reconnect: only an organization
 * admin can re-authorize it.
 */
export const InheritedConnectionCard = ({
  connection,
  pageScope = "workspace",
  highlightedOrg = null,
}: InheritedConnectionCardProps) => {
  const displayName = connection.label ?? "Connected account";
  const showAgentAccess = pageScope === "workspace";
  const avatarUrl = metaString(connection.metadata, "avatarUrl");
  const accountType = metaString(connection.metadata, "accountType");
  const accessLevel = connectionAccessLevelLabel(
    connection.provider,
    connection.metadata,
  );
  const tags = connectionTags(connection.metadata);
  const orgAccessIssues = connection.reauthRequiredAt
    ? []
    : extractGitHubOrgAccess(connection.metadata);

  return (
    <Card className="gap-2 border-dashed px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {avatarUrl ? (
            <Image
              src={avatarUrl}
              alt={displayName}
              width={28}
              height={28}
              unoptimized
              className="size-7 shrink-0 rounded-full"
            />
          ) : (
            <div className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-full">
              <Building2 className="text-muted-foreground size-3.5" />
            </div>
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{displayName}</p>
            <p className="text-muted-foreground text-xs">
              {connection.reauthRequiredAt ? (
                <span className="text-destructive">Needs reconnect</span>
              ) : orgAccessIssues.length > 0 ? (
                <>
                  Connected &middot;{" "}
                  <span className="text-amber-700 dark:text-amber-400">
                    {githubOrgAccessSummary(orgAccessIssues.length)}
                  </span>
                </>
              ) : (
                (accountTypeLabel(accountType) ?? "Connected")
              )}
              {accessLevel && (
                <span className="text-muted-foreground/60 whitespace-nowrap">
                  {" "}
                  &middot; {accessLevel}
                </span>
              )}
            </p>
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="text-muted-foreground shrink-0 gap-1 text-[11px] font-normal"
            >
              <Building2 className="size-3" aria-hidden="true" />
              Org
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-56">
            Managed by your organization. You choose which agents here use it.
          </TooltipContent>
        </Tooltip>
      </div>
      {connection.reauthRequiredAt && (
        <p className="text-muted-foreground text-xs">
          An organization admin can reconnect it from the organization&apos;s
          connections.
        </p>
      )}
      {orgAccessIssues.map((issue) => (
        <GitHubOrgAccessNotice
          key={issue.org}
          issue={issue}
          highlighted={issue.org === highlightedOrg?.toLowerCase()}
        />
      ))}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="text-xs">
              {tag}
            </Badge>
          ))}
        </div>
      )}
      {showAgentAccess && <ConnectionAgentRows connection={connection} />}
    </Card>
  );
};
