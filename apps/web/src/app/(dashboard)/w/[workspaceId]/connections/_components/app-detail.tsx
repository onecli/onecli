"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { openConnectPopup } from "@/lib/connect-popup";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Settings2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { cn } from "@onecli/ui/lib/utils";
import type { PageScope } from "@/lib/api";
import type { OAuthConfigField } from "@onecli/api/apps/types";
import { queryKeys } from "@/lib/api/keys";
import {
  useAppMessages,
  type AppConnectedEvent,
} from "@/hooks/use-app-connected";
import { useConnections } from "@/hooks/use-connections";
import { useInvalidateGrants } from "@/hooks/use-grants";
import { useAppConfigStatus } from "@/hooks/use-app-config";
import {
  WORKSPACE_PATH_RE,
  ORG_PATH_RE,
  connectionsPath,
} from "@/lib/navigation";
import { AppIcon } from "@/lib/components/app-icon";
import { AppConfigForm, type AppConfigFormHandle } from "./app-config-form";
import { ConfigureCredentialsDialog } from "./configure-credentials-dialog";
import { ConnectionAgentsReflection } from "@/lib/components/policy-reflect";
import { readConnectLinkAgent } from "@/lib/connect-link-agent";
import { useVerifiedConnectLinkAgent } from "@/hooks/use-verified-connect-link-agent";
import { SetupGuideLink } from "@/lib/components/setup-guide-link";
import { groupMembers, groupOf } from "@onecli/api/apps/oauth/groups";
import { AppConnectEmpty } from "./app-connect-empty";
import { ConnectionAccountCard } from "./connection-account-card";
import { InheritedConnectionCard } from "./inherited-connection-card";
import { AppBlocklist } from "./app-blocklist";
import { GitHubAppConnectDialog } from "./github-app-connect-dialog";
import type { AccountCardConnection } from "./account-card-connection";
import {
  GITHUB_APP_PROVIDER,
  useSharedGitHubInstallations,
} from "@/hooks/use-github-app-share";

interface AppDetailProps {
  app: {
    id: string;
    name: string;
    icon: string;
    darkIcon?: string;
    description: string;
    connectionType: "oauth" | "api_key" | "credentials_import";
    /** Offers an API-key method besides OAuth; connecting never requires
     *  OAuth setup first. */
    hasApiKeyAlternate?: boolean;
    blocklist?: { id: string; name: string; hostPattern: string }[];
    /** The app's OneCLI setup guide (`AppDefinition.setupGuideUrl`). */
    setupGuideUrl?: string;
  };
  configurable?: {
    fields: OAuthConfigField[];
    envDefaults?: Record<string, string>;
    hint?: string;
  };
  hasEnvDefaults: boolean;
  hasAppConfig: boolean;
  pageScope?: PageScope;
  backPath?: string;
}

export const AppDetail = ({
  app,
  configurable,
  hasEnvDefaults,
  hasAppConfig,
  pageScope = "workspace",
  backPath,
}: AppDetailProps) => {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const invalidateGrants = useInvalidateGrants();
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const configFormRef = useRef<AppConfigFormHandle>(null);

  const { data: allConnections = [], isPending: loading } =
    useConnections(pageScope);
  const { connections, inheritedConnections } = useMemo(() => {
    const forProvider: AccountCardConnection[] = allConnections
      .filter((c) => c.provider === app.id && c.status === "connected")
      .map((c) => ({
        ...c,
        metadata: c.metadata as Record<string, unknown> | null,
      }));
    return {
      connections: forProvider.filter((c) => c.scope === pageScope || !c.scope),
      inheritedConnections: forProvider.filter(
        (c) => c.scope && c.scope !== pageScope,
      ),
    };
  }, [allConnections, app.id, pageScope]);

  // A successful connect opens the account's agent-access dialog right here:
  // a new workspace account is on for no agent, and this is where the user
  // turns it on for the ones that should have it. The `open` flag outlives
  // the id so closing keeps the exit animation.
  const [justConnectedId, setJustConnectedId] = useState<string | null>(null);
  const [justConnectedOpen, setJustConnectedOpen] = useState(false);
  // Agents are workspace-scoped, so this only means anything on a workspace page.
  const canAttachAgents = pageScope === "workspace";
  const openJustConnected = useCallback((connectionId: string) => {
    setJustConnectedId(connectionId);
    setJustConnectedOpen(true);
  }, []);

  const handleConnected = useCallback(
    ({ provider, connectionId }: AppConnectedEvent) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.counts.all() });
      // The connection list, plus every grant view the agent-access dialog
      // and the account cards read.
      invalidateGrants();
      // Only a CREATED connection carries an id — a reconnect refreshed
      // credentials an agent already had, and needs no setup step. The
      // provider has to match too: a popup keeps posting to its opener across
      // client-side navigation, so one opened from another app's page can land
      // here and would otherwise title someone else's account "<this app>
      // connected".
      if (connectionId && provider === app.id && canAttachAgents)
        openJustConnected(connectionId);
    },
    [queryClient, invalidateGrants, app.id, canAttachAgents, openJustConnected],
  );

  useAppMessages({ onConnected: handleConnected });

  // `?connected=<id>` — the same handoff for the other way in: connecting from
  // the Apps grid navigates here on success, so this page mounts long after the
  // popup's message was posted and can only learn of it from the URL. One-shot
  // per mount, then stripped so a refresh doesn't reopen the dialog.
  const connectedParam = searchParams.get("connected");
  // `?reconnect=<id>`: the agent's `connection_needs_reconnect` link. Marks the
  // account to reconnect while it still needs it; the popup itself needs the
  // user's click.
  const reconnectParam = searchParams.get("reconnect");
  // `?org_access=<org>`: the agent's `github_org_access_required` link. Marks
  // that organization's notice on the account that recorded it.
  const orgAccessParam = searchParams.get("org_access");
  const consumedConnectedParam = useRef(false);
  useEffect(() => {
    if (consumedConnectedParam.current) return;
    if (!connectedParam || !canAttachAgents) return;
    consumedConnectedParam.current = true;
    openJustConnected(connectedParam);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("connected");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [
    connectedParam,
    canAttachAgents,
    openJustConnected,
    searchParams,
    router,
    pathname,
  ]);

  // The RSC page seeds the very first render; the query converges after.
  const { data: configStatus } = useAppConfigStatus(
    app.id,
    pageScope,
    !!configurable,
  );
  const appConfigured = configStatus?.enabled ?? hasAppConfig;

  const hasCredentials = hasEnvDefaults || appConfigured;

  // `?source=agent&agent_id=`: an agent's connect door sent the user here to
  // set the app's credentials up first. A NEW account connected from this
  // visit is still that agent's; a reconnect never names one.
  const linkAgent = useVerifiedConnectLinkAgent(
    canAttachAgents ? readConnectLinkAgent(searchParams) : undefined,
  );
  const openPopup = (connectionId?: string, options?: { height?: number }) =>
    openConnectPopup(app.id, {
      ...options,
      connectionId,
      ...(linkAgent && !connectionId
        ? { agentId: linkAgent.id, agentName: linkAgent.name }
        : {}),
      workspaceId: pathname.match(WORKSPACE_PATH_RE)?.[1],
      orgId:
        pageScope === "organization"
          ? pathname.match(ORG_PATH_RE)?.[1]
          : undefined,
    });

  const popupOpts =
    app.connectionType === "credentials_import" ? { height: 820 } : undefined;

  // GitHub App: GitHub won't offer a second install on the same account, so
  // an org admin is offered the org's connected installations first.
  const isGitHubApp = app.id === GITHUB_APP_PROVIDER;
  const [githubDialogOpen, setGithubDialogOpen] = useState(false);
  const { data: sharedInstallations = [] } = useSharedGitHubInstallations(
    pageScope,
    isGitHubApp,
  );

  const handleConnect = () => {
    if (!hasCredentials && configurable?.fields && !app.hasApiKeyAlternate) {
      setConfigDialogOpen(true);
      return;
    }
    if (isGitHubApp && sharedInstallations.length > 0) {
      setGithubDialogOpen(true);
      return;
    }
    openPopup(undefined, popupOpts);
  };

  const connectionCount = connections.length + inheritedConnections.length;
  const isConnected = connectionCount > 0;
  // A vendor-shared client serves every app of its vendor, so changing it
  // disconnects all of them: the config form confirms when ANY is connected
  // (counted the way `isConnected` counts this app's own accounts).
  const clientInUse = useMemo(() => {
    const group = groupOf(app.id);
    if (!group) return isConnected;
    const members = new Set(groupMembers(group));
    return allConnections.some(
      (c) => members.has(c.provider) && c.status === "connected",
    );
  }, [allConnections, app.id, isConnected]);

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        href={backPath ?? connectionsPath({ pathname })}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        Apps
      </Link>

      {/* Header with actions */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border bg-muted dark:bg-white/10 dark:border-white/10">
            <AppIcon
              icon={app.icon}
              darkIcon={app.darkIcon}
              name={app.name}
              size={24}
            />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-semibold tracking-tight">
                {app.name}
              </h1>
              {isConnected && (
                <div className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-brand" />
                  <span className="text-xs font-medium text-brand">
                    {connectionCount > 1
                      ? `${connectionCount} accounts connected`
                      : "Connected"}
                  </span>
                </div>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              {app.description}
            </p>
          </div>
        </div>

        {/* Actions in header */}
        <div className="flex items-center gap-2 shrink-0">
          {loading ? (
            <Skeleton className="h-8 w-32 rounded-md" />
          ) : (
            <>
              {configurable && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => configFormRef.current?.reveal()}
                  aria-label="Custom credentials"
                  className="shrink-0"
                >
                  <Settings2 className="size-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">Custom credentials</span>
                </Button>
              )}
              {!isConnected && (
                <Button size="sm" onClick={handleConnect} className="shrink-0">
                  Connect {app.name}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Apps with a Custom credentials card show the guide inside it, right
          above the Redirect URI. The rest show it here. */}
      {!configurable && (
        <SetupGuideLink appName={app.name} url={app.setupGuideUrl} />
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : !isConnected ? (
        <AppConnectEmpty
          appName={app.name}
          pageScope={pageScope}
          onConnect={handleConnect}
        />
      ) : (
        <div className="space-y-3">
          <div className="flex items-start justify-between">
            <h3 className="text-sm font-medium">Connected accounts</h3>
            <Button
              variant="outline"
              size="sm"
              onClick={handleConnect}
              className="shrink-0"
            >
              Connect
            </Button>
          </div>
          {connections.length > 0 && inheritedConnections.length > 0 && (
            <p className="text-xs font-medium text-muted-foreground">
              Workspace accounts
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {connections.map((conn) => (
              <ConnectionAccountCard
                key={conn.id}
                connection={conn}
                appName={app.name}
                onReconnect={(id) => openPopup(id, popupOpts)}
                pageScope={pageScope}
                highlighted={
                  conn.id === reconnectParam && !!conn.reauthRequiredAt
                }
                highlightedOrg={orgAccessParam}
              />
            ))}
          </div>
          {inheritedConnections.length > 0 && (
            <>
              <p
                className={cn(
                  "text-xs font-medium text-muted-foreground",
                  connections.length > 0 && "pt-3",
                )}
              >
                Organization accounts
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {inheritedConnections.map((conn) => (
                  <InheritedConnectionCard
                    key={conn.id}
                    connection={conn}
                    pageScope={pageScope}
                    highlightedOrg={orgAccessParam}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {configurable && (
        <AppConfigForm
          ref={configFormRef}
          provider={app.id}
          appName={app.name}
          fields={configurable.fields}
          hint={configurable.hint}
          setupGuideUrl={app.setupGuideUrl}
          hasEnvDefaults={hasEnvDefaults}
          isConnected={clientInUse}
          pageScope={pageScope}
        />
      )}

      {app.blocklist && app.blocklist.length > 0 && (
        <AppBlocklist
          provider={app.id}
          hosts={app.blocklist}
          isConnected={isConnected}
          pageScope={pageScope}
        />
      )}

      {configurable?.fields && (
        <ConfigureCredentialsDialog
          provider={app.id}
          appName={app.name}
          appIcon={app.icon}
          appDarkIcon={app.darkIcon}
          fields={configurable.fields}
          hint={configurable.hint}
          setupGuideUrl={app.setupGuideUrl}
          open={configDialogOpen}
          onOpenChange={setConfigDialogOpen}
          pageScope={pageScope}
          onConfigured={() => {
            setConfigDialogOpen(false);
            openPopup(undefined, popupOpts);
          }}
        />
      )}

      {isGitHubApp && (
        <GitHubAppConnectDialog
          open={githubDialogOpen}
          onOpenChange={setGithubDialogOpen}
          pageScope={pageScope}
          agentId={linkAgent?.id}
          onInstallNew={() => openPopup(undefined, popupOpts)}
          onConnected={(id) => {
            if (canAttachAgents) openJustConnected(id);
          }}
        />
      )}

      {/* Rendered here rather than from the account card: the card for a
          just-created account doesn't exist until the connections query
          refetches, and this dialog's own queries are keyed on the id, so it
          works immediately. Re-keyed per connection so a second connect can't
          inherit the first one's row state. */}
      {justConnectedId && (
        <ConnectionAgentsReflection
          key={justConnectedId}
          connectionId={justConnectedId}
          appName={app.name}
          open={justConnectedOpen}
          onOpenChange={setJustConnectedOpen}
        />
      )}
    </div>
  );
};
