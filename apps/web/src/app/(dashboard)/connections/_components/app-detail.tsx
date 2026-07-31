"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Settings2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import type { Connection, PageScope } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import {
  useAppMessages,
  type AppConnectedEvent,
} from "@/hooks/use-app-connected";
import { useConnections } from "@/hooks/use-connections";
import { useAppConfigStatus } from "@/hooks/use-app-config";
import {
  PROJECT_PATH_RE,
  ORG_PATH_RE,
  withProjectPrefix,
} from "@/lib/navigation";
import { AppIcon } from "./app-icon";
import { AppConfigForm, type AppConfigFormHandle } from "./app-config-form";
import { ConfigureCredentialsDialog } from "./configure-credentials-dialog";
import { ConnectionAgentsReflection } from "@/lib/components/policy-reflect";
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
}: AppDetailProps) => {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
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

  // A brand-new account is useless until an agent is attached to it, and this
  // is the moment the user is thinking about it — so a successful connect opens
  // the account's agent-access dialog right here, where there is room for it.
  // The `open` flag outlives the id so closing keeps the exit animation.
  const [justConnectedId, setJustConnectedId] = useState<string | null>(null);
  const [justConnectedOpen, setJustConnectedOpen] = useState(false);
  // Agents are project-scoped, so this only means anything on a project page.
  const canAttachAgents = pageScope === "project";
  const openJustConnected = useCallback((connectionId: string) => {
    setJustConnectedId(connectionId);
    setJustConnectedOpen(true);
  }, []);

  const handleConnected = useCallback(
    ({ provider, connectionId }: AppConnectedEvent) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connections.all() });
      queryClient.invalidateQueries({ queryKey: queryKeys.counts.all() });
      // Only a CREATED connection carries an id — a reconnect refreshed
      // credentials an agent already had, and needs no setup step. The
      // provider has to match too: a popup keeps posting to its opener across
      // client-side navigation, so one opened from another app's page can land
      // here and would otherwise title someone else's account "<this app>
      // connected".
      if (connectionId && provider === app.id && canAttachAgents)
        openJustConnected(connectionId);
    },
    [queryClient, app.id, canAttachAgents, openJustConnected],
  );

  useAppMessages({ onConnected: handleConnected });

  // `?connected=<id>` — the same handoff for the other way in: connecting from
  // the Apps grid navigates here on success, so this page mounts long after the
  // popup's message was posted and can only learn of it from the URL. One-shot
  // per mount, then stripped so a refresh doesn't reopen the dialog.
  const connectedParam = searchParams.get("connected");
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
        isConnected && (
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
        )
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

      {/* Rendered here rather than from the account card: the card for a
          just-created account doesn't exist until the connections query
          refetches, and this dialog's own queries are keyed on the id, so it
          works immediately. Re-keyed per connection so a second connect can't
          inherit the first one's row state. */}
      {justConnectedId && (
        <ConnectionAgentsReflection
          key={justConnectedId}
          connectionId={justConnectedId}
          // Only the neutral header renders this; the success header titles on
          // the app, precisely so it doesn't wait on the refetch.
          connectionLabel={
            connections.find((c) => c.id === justConnectedId)?.label ?? ""
          }
          appName={app.name}
          justConnected
          open={justConnectedOpen}
          onOpenChange={setJustConnectedOpen}
        />
      )}
    </div>
  );
};
