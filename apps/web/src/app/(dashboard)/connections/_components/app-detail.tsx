"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { getAppConnections as defaultGetConnections } from "@/lib/actions/connections";
import { checkAppConfigExists as defaultCheckConfig } from "@/lib/actions/app-config";
import { Card } from "@onecli/ui/components/card";
import { useAppMessages } from "@/hooks/use-app-connected";
import { useInvalidateGatewayCache } from "@/hooks/use-invalidate-cache";
import { withProjectPrefix } from "@/lib/navigation";
import type { OAuthPermission } from "@/lib/apps/types";
import { AppIcon } from "./app-icon";
import { AppConfigForm } from "./app-config-form";
import { ConfigureCredentialsDialog } from "./configure-credentials-dialog";
import { ConnectionCard } from "./connection-card";
import { PermissionsList } from "./permissions-list";

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
  getConnections?: typeof defaultGetConnections;
  checkAppConfig?: typeof defaultCheckConfig;
  disconnectAction?: (connectionId: string) => Promise<void>;
  pageScope?: "project" | "organization";
  backPath?: string;
}

interface ConnectionData {
  id: string;
  label: string | null;
  provider: string;
  status: string;
  scopes: string[];
  scope?: string;
  metadata: Record<string, unknown> | null;
  connectedAt: Date;
}

export const AppDetail = ({
  app,
  configurable,
  hasEnvDefaults,
  hasAppConfig,
  getConnections = defaultGetConnections,
  checkAppConfig = defaultCheckConfig,
  disconnectAction,
  pageScope = "project",
  backPath,
}: AppDetailProps) => {
  const pathname = usePathname();
  const [connections, setConnections] = useState<ConnectionData[]>([]);
  const [inheritedConnections, setInheritedConnections] = useState<
    ConnectionData[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [configVersion, setConfigVersion] = useState(0);
  const [appConfigured, setAppConfigured] = useState(hasAppConfig);

  const fetchConnections = useCallback(async () => {
    try {
      const allConnections = await getConnections();
      const forProvider = allConnections
        .filter((c) => c.provider === app.id && c.status === "connected")
        .map((c) => ({
          ...c,
          metadata: c.metadata as Record<string, unknown> | null,
        }));
      setConnections(
        forProvider.filter((c) => c.scope === pageScope || !c.scope),
      );
      setInheritedConnections(
        forProvider.filter((c) => c.scope && c.scope !== pageScope),
      );
    } catch {
      // Connection fetch failed — show as disconnected
    } finally {
      setLoading(false);
    }
  }, [app.id, getConnections, pageScope]);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  const invalidateCache = useInvalidateGatewayCache();

  const handleConnected = useCallback(() => {
    fetchConnections();
    invalidateCache();
  }, [fetchConnections, invalidateCache]);

  useAppMessages({ onConnected: handleConnected });

  const refreshConfigStatus = useCallback(async () => {
    fetchConnections();
    try {
      const exists = await checkAppConfig(app.id);
      setAppConfigured(exists);
    } catch {
      // ignore
    }
  }, [app.id, fetchConnections, checkAppConfig]);

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
    if (pageScope === "organization") params.set("org", "true");
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
        {loading ? (
          <Skeleton className="h-9 w-32 shrink-0 rounded-md" />
        ) : (
          <div className="flex items-center gap-2 shrink-0">
            {isConnected ? (
              <Button variant="outline" size="sm" onClick={handleConnect}>
                Connect Another Account
              </Button>
            ) : (
              <Button size="sm" onClick={handleConnect}>
                Connect {app.name}
              </Button>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {connections.length > 0 && (
            <div className="space-y-2">
              {inheritedConnections.length > 0 && (
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Project
                </p>
              )}
              {connections.map((conn) => {
                const manageUrl =
                  typeof conn.metadata?.manageUrl === "string"
                    ? conn.metadata.manageUrl
                    : undefined;

                return (
                  <ConnectionCard
                    key={conn.id}
                    connection={conn}
                    appName={app.name}
                    onReconnect={
                      manageUrl
                        ? () => window.open(manageUrl, "_blank")
                        : (id) => openConnectPopup(id, popupOpts)
                    }
                    reconnectLabel={manageUrl ? "Manage" : undefined}
                    onDisconnected={fetchConnections}
                    disconnectAction={disconnectAction}
                  />
                );
              })}
            </div>
          )}
          {inheritedConnections.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Organization
              </p>
              {inheritedConnections.map((conn) => (
                <Card
                  key={conn.id}
                  className="flex-row items-center justify-between gap-3 px-4 py-3 opacity-60 border-dashed"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {conn.label ?? "Connected account"}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Connected{" "}
                      {new Date(conn.connectedAt).toLocaleDateString("en-US", {
                        month: "long",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </p>
                  </div>
                </Card>
              ))}
            </div>
          )}
          {app.permissions.length > 0 && (
            <PermissionsList
              permissions={app.permissions}
              grantedScopes={
                isConnected
                  ? [
                      ...new Set(
                        [...connections, ...inheritedConnections].flatMap(
                          (c) => c.scopes,
                        ),
                      ),
                    ]
                  : undefined
              }
            />
          )}
        </>
      )}

      {configurable && (
        <AppConfigForm
          key={configVersion}
          provider={app.id}
          appName={app.name}
          fields={configurable.fields}
          hint={configurable.hint}
          hasEnvDefaults={hasEnvDefaults}
          isConnected={isConnected}
          onConfigChange={refreshConfigStatus}
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
          onConfigured={() => {
            setConfigDialogOpen(false);
            setConfigVersion((v) => v + 1);
            setAppConfigured(true);
            openConnectPopup(undefined, popupOpts);
          }}
        />
      )}
    </div>
  );
};
