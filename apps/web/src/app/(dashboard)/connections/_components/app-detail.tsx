"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Settings2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import type { Connection, PageScope } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { useAppMessages } from "@/hooks/use-app-connected";
import { useConnections } from "@/hooks/use-connections";
import { useAppConfigStatus } from "@/hooks/use-app-config";
import {
  PROJECT_PATH_RE,
  ORG_PATH_RE,
  withProjectPrefix,
} from "@/lib/navigation";
import type { OAuthPermission } from "@onecli/api/apps/types";
import type { AppPermissionLevel } from "@onecli/api/apps/app-permissions";
import { useAppPermissionDefinitions } from "@/hooks/use-app-permissions";
import { AppIcon } from "./app-icon";
import { AppConfigForm, type AppConfigFormHandle } from "./app-config-form";
import { ConfigureCredentialsDialog } from "./configure-credentials-dialog";
import { PermissionsList } from "./permissions-list";
import { AppPermissions } from "./app-permissions";
import { ConnectionAccountCard } from "./connection-account-card";
import { InheritedConnectionCard } from "./inherited-connection-card";
import { AppBlocklist } from "./app-blocklist";

interface AppDetailProps {
  app: {
    id: string;
    name: string;
    icon: string;
    darkIcon?: string;
    description: string;
    connectionType: "oauth" | "api_key" | "credentials_import" | "cloud_only";
    defaultScopes: string[];
    permissions: OAuthPermission[];
    blocklist?: { id: string; name: string; hostPattern: string }[];
  };
  configurable?: {
    fields: {
      name: string;
      label: string;
      description?: string;
      placeholder: string;
      secret?: boolean;
    }[];
    envDefaults?: Record<string, string>;
    hint?: string;
  };
  hasEnvDefaults: boolean;
  hasAppConfig: boolean;
  pageScope?: PageScope;
  backPath?: string;
  orgPermissionStates?: Record<string, AppPermissionLevel>;
  orgConditions?: Record<string, unknown[]>;
  policyMode?: "allow" | "deny";
}

type ConnectionData = Omit<Connection, "metadata"> & {
  metadata: Record<string, unknown> | null;
};

export const AppDetail = ({
  app,
  configurable,
  hasEnvDefaults,
  hasAppConfig,
  pageScope = "project",
  backPath,
  orgPermissionStates,
  orgConditions,
  policyMode,
}: AppDetailProps) => {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const configFormRef = useRef<AppConfigFormHandle>(null);

  const { data: allConnections = [], isPending: loading } =
    useConnections(pageScope);
  const { connections, inheritedConnections } = useMemo(() => {
    const forProvider: ConnectionData[] = allConnections
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

  const handleConnected = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.connections.all() });
    queryClient.invalidateQueries({ queryKey: queryKeys.counts.all() });
  }, [queryClient]);

  useAppMessages({ onConnected: handleConnected });

  // The RSC page seeds the very first render; the query converges after.
  const { data: configStatus } = useAppConfigStatus(
    app.id,
    pageScope,
    !!configurable,
  );
  const appConfigured = configStatus?.enabled ?? hasAppConfig;

  const hasCredentials = hasEnvDefaults || appConfigured;
  const { data: permissionDefinitions, isPending: permissionsPending } =
    useAppPermissionDefinitions();
  const permissionDefinition = permissionDefinitions?.find(
    (def) => def.provider === app.id,
  );

  const openConnectPopup = (
    connectionId?: string,
    options?: { height?: number },
  ) => {
    const w = 520;
    const h = options?.height ?? 700;
    const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
    const params = new URLSearchParams();
    if (connectionId) params.set("connectionId", connectionId);
    const projectMatch = pathname.match(PROJECT_PATH_RE)?.[1];
    if (projectMatch) params.set("projectId", projectMatch);
    if (pageScope === "organization") {
      const orgMatch = pathname.match(ORG_PATH_RE)?.[1];
      if (orgMatch) params.set("orgId", orgMatch);
    }
    const qs = params.toString();
    const url = `/app-connect/${app.id}${qs ? `?${qs}` : ""}`;
    window.open(
      url,
      `connect-${app.id}-${connectionId ?? "new"}`,
      `width=${w},height=${h},left=${left},top=${top},scrollbars=yes,resizable=yes`,
    );
  };

  const popupOpts =
    app.connectionType === "credentials_import" ? { height: 820 } : undefined;

  const handleConnect = () => {
    if (!hasCredentials && configurable?.fields) {
      setConfigDialogOpen(true);
      return;
    }
    openConnectPopup(undefined, popupOpts);
  };

  const connectionCount = connections.length + inheritedConnections.length;
  const isConnected = connectionCount > 0;
  // Hold the OAuth-scopes fallback until the catalog resolves, so it doesn't
  // flash before being replaced by the permissions editor.
  const showOAuthScopesList =
    !permissionsPending && isConnected && app.permissions.length > 0;

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        href={backPath ?? withProjectPrefix(pathname, "/connections")}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        Apps
      </Link>

      {/* Header with actions */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border bg-muted">
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

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-6">
          {isConnected && (
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
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {connections.map((conn) => (
                  <ConnectionAccountCard
                    key={conn.id}
                    connection={conn}
                    appName={app.name}
                    onReconnect={(id) => openConnectPopup(id, popupOpts)}
                    pageScope={pageScope}
                  />
                ))}
                {inheritedConnections.map((conn) => (
                  <InheritedConnectionCard
                    key={conn.id}
                    connection={conn}
                    appName={app.name}
                    pageScope={pageScope}
                  />
                ))}
              </div>
            </div>
          )}

          {permissionDefinition ? (
            <AppPermissions
              provider={app.id}
              appName={app.name}
              groups={permissionDefinition.groups}
              orgStates={orgPermissionStates}
              orgConditions={orgConditions}
              policyMode={policyMode}
              pageScope={pageScope}
            />
          ) : showOAuthScopesList ? (
            <PermissionsList
              permissions={app.permissions}
              grantedScopes={[
                ...new Set(
                  [...connections, ...inheritedConnections].flatMap(
                    (c) => c.scopes,
                  ),
                ),
              ]}
            />
          ) : null}
        </div>
      )}

      {configurable && (
        <AppConfigForm
          ref={configFormRef}
          provider={app.id}
          appName={app.name}
          fields={configurable.fields}
          hint={configurable.hint}
          hasEnvDefaults={hasEnvDefaults}
          isConnected={isConnected}
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
          open={configDialogOpen}
          onOpenChange={setConfigDialogOpen}
          pageScope={pageScope}
          onConfigured={() => {
            setConfigDialogOpen(false);
            openConnectPopup(undefined, popupOpts);
          }}
        />
      )}
    </div>
  );
};
