"use client";

import { useState } from "react";
import Image from "next/image";
import { toast } from "sonner";
import {
  Building2,
  ChevronRight,
  FolderGit2,
  Globe,
  Loader2,
  MoreVertical,
  Pencil,
  RefreshCw,
  Settings,
  Unplug,
  User,
} from "lucide-react";
import { Card } from "@onecli/ui/components/card";
import { Badge } from "@onecli/ui/components/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@onecli/ui/components/alert-dialog";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import {
  useDisconnectConnection,
  usePromoteConnection,
} from "@/hooks/use-connections";
import { GITHUB_APP_PROVIDER } from "@/hooks/use-github-app-share";
import { useOrgMembership } from "@/hooks/use-org";
import type { PageScope } from "@/lib/api";
import { connectionAccessLevelLabel } from "@onecli/api/apps/access-level";
import {
  connectionTags,
  extractBoundHost,
  extractLabel,
} from "@onecli/api/lib/connection-display";
import {
  extractGitHubOrgAccess,
  githubOrgAccessSummary,
} from "@onecli/api/lib/github-org-access";
import { GitHubOrgAccessNotice } from "./github-org-access-notice";
import { MissingPermissionsNotice } from "@/lib/components/missing-permissions-notice";
import { ConnectionAgentRows } from "./connection-agent-rows";
import { RenameConnectionDialog } from "./rename-connection-dialog";
import { EditRepositoriesDialog } from "./edit-repositories-dialog";
import {
  isGitHubUrl,
  openGitHubSettingsPopup,
} from "@/lib/github-settings-popup";
import type { AccountCardConnection } from "./account-card-connection";
import { accountTypeLabel } from "@/lib/connections/account-type-label";

/** A refused login: nothing (including a repo edit) works until reconnect. */
const needsReconnectFor = (c: AccountCardConnection) => !!c.reauthRequiredAt;

interface ConnectionAccountCardProps {
  connection: AccountCardConnection;
  appName: string;
  onReconnect: (connectionId: string) => void;
  pageScope?: PageScope;
  /** The agent's reconnect link pointed here (`?reconnect=<id>`). */
  highlighted?: boolean;
  /** The agent's `?org_access=<org>` link named this GitHub organization. */
  highlightedOrg?: string | null;
}

export const ConnectionAccountCard = ({
  connection,
  appName,
  onReconnect,
  pageScope = "workspace",
  highlighted = false,
  highlightedOrg = null,
}: ConnectionAccountCardProps) => {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const disconnectMutation = useDisconnectConnection(pageScope);
  const promoteMutation = usePromoteConnection();
  // Agents are workspace-scoped, so agent access (and moving an account up to
  // the org) only applies on the workspace page.
  const isWorkspacePage = pageScope === "workspace";
  // Org admins can move a workspace account up to Shared Connections. A
  // shared GitHub connection is already a narrowed copy of an installation
  // the org can share directly, so it is not offered there (the API refuses).
  const { data: membership } = useOrgMembership(
    isWorkspacePage || connection.provider === GITHUB_APP_PROVIDER,
  );
  const canPromote =
    isWorkspacePage &&
    membership?.isAdmin === true &&
    !connection.sourceConnectionId;
  // Which repos a GitHub connection reaches can change after connecting
  // (org admins, the same rule as sharing; the API refuses anyone else).
  const canEditRepos =
    connection.provider === GITHUB_APP_PROVIDER &&
    membership?.isAdmin === true &&
    !needsReconnectFor(connection);
  const [reposOpen, setReposOpen] = useState(false);

  const displayName =
    connection.label ??
    extractLabel(connection.metadata ?? undefined) ??
    "Unknown account";

  const avatarUrl = connection.metadata?.avatarUrl as string | undefined;
  const accountType = connection.metadata?.accountType as string | undefined;
  // Which kind of token the account holds, for apps that offer more than one
  // (Attio's workspace vs personal access).
  const accessLevel = connectionAccessLevelLabel(
    connection.provider,
    connection.metadata,
  );
  const tags = connectionTags(connection.metadata);
  const boundHost = extractBoundHost(connection.metadata);
  const needsReconnect = !!connection.reauthRequiredAt;
  const missing = connection.missingPermissions ?? [];
  // A refused login outranks it: nothing works until that reconnect anyway.
  const missingPermissions = !needsReconnect && missing.length > 0;
  // GitHub organizations that refused this account (recorded by the gateway).
  // Per-organization: the account stays connected for everything else.
  const orgAccessIssues = extractGitHubOrgAccess(connection.metadata);

  const handleDisconnect = () => {
    disconnectMutation.mutate(connection.id, {
      onSuccess: () => {
        toast.success(`${appName} account disconnected`);
      },
    });
  };

  return (
    <>
      <Card
        className={cn(
          "gap-2 px-4 py-3",
          needsReconnect && "border-destructive/50",
          missingPermissions && "border-amber-500/40",
          highlighted && "ring-2 ring-ring",
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {avatarUrl ? (
              <Image
                src={avatarUrl}
                alt={displayName}
                width={28}
                height={28}
                unoptimized
                className="size-7 rounded-full shrink-0"
              />
            ) : (
              <div className="flex size-7 items-center justify-center rounded-full bg-muted shrink-0">
                {accountType === "Organization" ? (
                  <Building2 className="size-3.5 text-muted-foreground" />
                ) : (
                  <User className="size-3.5 text-muted-foreground" />
                )}
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{displayName}</p>
              {boundHost && (
                <a
                  href={`https://${boundHost}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={boundHost}
                  className="flex items-center gap-1 rounded-sm text-xs font-mono text-muted-foreground truncate hover:text-foreground hover:underline focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
                >
                  <Globe className="size-3 shrink-0" aria-hidden="true" />
                  <span className="truncate" translate="no">
                    {boundHost}
                  </span>
                </a>
              )}
              <p className="text-xs text-muted-foreground">
                {needsReconnect ? (
                  <span className="text-destructive">Needs reconnect</span>
                ) : missingPermissions ? (
                  <span className="text-amber-700 dark:text-amber-400">
                    Connected &middot; Missing permissions
                  </span>
                ) : orgAccessIssues.length > 0 ? (
                  <span className="text-amber-700 dark:text-amber-400">
                    Connected &middot;{" "}
                    {githubOrgAccessSummary(orgAccessIssues.length)}
                  </span>
                ) : (
                  (accountTypeLabel(accountType) ?? "Connected")
                )}{" "}
                {accessLevel && (
                  <span className="text-muted-foreground/60 whitespace-nowrap">
                    &middot; {accessLevel}{" "}
                  </span>
                )}
                {connection.sourceConnectionId && (
                  <span className="text-muted-foreground/60">
                    &middot; Shared{" "}
                  </span>
                )}
                <span className="text-muted-foreground/60">
                  &middot;{" "}
                  {new Date(connection.connectedAt).toLocaleDateString(
                    "en-US",
                    { month: "short", day: "numeric", year: "numeric" },
                  )}
                </span>
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {needsReconnect && !connection.metadata?.manageUrl && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onReconnect(connection.id)}
              >
                <RefreshCw className="size-3.5" aria-hidden="true" />
                Reconnect
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={`Actions for ${displayName}`}
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-muted-foreground"
                >
                  <MoreVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canEditRepos && (
                  <DropdownMenuItem onClick={() => setReposOpen(true)}>
                    <FolderGit2 className="size-4" />
                    Edit repositories
                  </DropdownMenuItem>
                )}
                {isGitHubUrl(connection.metadata?.manageUrl) && (
                  <DropdownMenuItem
                    onClick={() =>
                      openGitHubSettingsPopup(connection.metadata?.manageUrl)
                    }
                  >
                    <Settings className="size-4" />
                    Settings
                  </DropdownMenuItem>
                )}
                {!connection.metadata?.manageUrl && (
                  <DropdownMenuItem onClick={() => onReconnect(connection.id)}>
                    <RefreshCw className="size-4" />
                    Reconnect
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => setRenameOpen(true)}>
                  <Pencil className="size-4" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setConfirmOpen(true)}
                  disabled={disconnectMutation.isPending}
                  className="text-destructive focus:text-destructive"
                >
                  {disconnectMutation.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Unplug className="size-4" />
                  )}
                  {disconnectMutation.isPending
                    ? "Disconnecting..."
                    : "Disconnect"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {needsReconnect && (
          <p className="text-xs text-muted-foreground">
            {appName} rejected the saved login, so agents can&apos;t use this
            account until you reconnect it. Agent access and rules are kept.
          </p>
        )}
        {missingPermissions && (
          <MissingPermissionsNotice
            permissions={missing}
            onReconnect={() => onReconnect(connection.id)}
          />
        )}
        {!needsReconnect &&
          orgAccessIssues.map((issue) => (
            <GitHubOrgAccessNotice
              key={issue.org}
              issue={issue}
              highlighted={issue.org === highlightedOrg?.toLowerCase()}
              onReconnect={
                connection.metadata?.manageUrl
                  ? undefined
                  : () => onReconnect(connection.id)
              }
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
        {isWorkspacePage && <ConnectionAgentRows connection={connection} />}
        {canPromote && (
          <button
            type="button"
            onClick={() => setPromoteOpen(true)}
            className="text-muted-foreground hover:text-foreground hover:bg-muted/60 focus-visible:ring-ring -mx-4 -mb-3 mt-1 flex items-center justify-between gap-2 rounded-b-xl border-t px-4 py-2 text-left text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <span className="flex items-center gap-1.5">
              <Building2 className="size-3.5" aria-hidden="true" />
              Share with organization
            </span>
            <ChevronRight className="size-3.5 opacity-60" aria-hidden="true" />
          </button>
        )}
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will revoke access and remove the stored credentials for this{" "}
              {appName} account. Agents using this connection will no longer be
              able to authenticate.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDisconnect}
              variant="destructive"
              disabled={disconnectMutation.isPending}
            >
              {disconnectMutation.isPending ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Disconnecting...
                </>
              ) : (
                "Disconnect"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RenameConnectionDialog
        connectionId={connection.id}
        initialLabel={displayName === "Unknown account" ? "" : displayName}
        scope={pageScope}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />

      {canEditRepos && (
        <EditRepositoriesDialog
          connectionId={connection.id}
          account={displayName}
          manageUrl={
            typeof connection.metadata?.manageUrl === "string"
              ? connection.metadata.manageUrl
              : null
          }
          pageScope={pageScope}
          open={reposOpen}
          onOpenChange={setReposOpen}
        />
      )}

      <AlertDialog open={promoteOpen} onOpenChange={setPromoteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Share {displayName} with the organization?
            </AlertDialogTitle>
            <AlertDialogDescription>
              It moves to Shared Connections and every workspace can use it.
              Agents here keep their access and permissions. Only organization
              admins can rename or disconnect it after this.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={promoteMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                promoteMutation.mutate(connection.id, {
                  onSuccess: () => {
                    toast.success(`${displayName} is now shared`);
                    setPromoteOpen(false);
                  },
                });
              }}
            >
              {promoteMutation.isPending ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Sharing...
                </>
              ) : (
                "Share"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
