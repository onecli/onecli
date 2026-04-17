"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { cn } from "@onecli/ui/lib/utils";
import type { AppDefinition } from "@/lib/apps/types";
import { getAppConnections } from "@/lib/actions/connections";
import {
  getConfiguredProviders,
  getAvailableEnvDefaults,
} from "@/lib/actions/app-config";
import { apps } from "@/lib/apps/registry";
import { RequestAppSlot } from "@/lib/components/request-app-slot";
import { useAppMessages } from "@/hooks/use-app-connected";
import { useInvalidateGatewayCache } from "@/hooks/use-invalidate-cache";
import { AppIcon } from "./app-icon";
import { ConnectAppDialog } from "./connect-app-dialog";
import { ConfigureCredentialsDialog } from "./configure-credentials-dialog";
import { useConnectParam } from "./use-connect-param";

export const AppsTab = () => {
  const router = useRouter();
  const [connectionCounts, setConnectionCounts] = useState<Map<string, number>>(
    () => new Map(),
  );
  const [configuredProviders, setConfiguredProviders] = useState<Set<string>>(
    () => new Set(),
  );
  const [envDefaultProviders, setEnvDefaultProviders] = useState<Set<string>>(
    () => new Set(),
  );
  const [configApp, setConfigApp] = useState<AppDefinition | null>(null);
  const [connectApp, setConnectApp] = useState<AppDefinition | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchConnections = useCallback(async () => {
    try {
      const [connections, availableDefaults, configured] = await Promise.all([
        getAppConnections(),
        getAvailableEnvDefaults(),
        getConfiguredProviders().catch(() => [] as string[]),
      ]);
      const counts = new Map<string, number>();
      for (const c of connections.filter((c) => c.status === "connected")) {
        counts.set(c.provider, (counts.get(c.provider) ?? 0) + 1);
      }
      setConnectionCounts(counts);
      setEnvDefaultProviders(new Set(availableDefaults));
      setConfiguredProviders(new Set(configured));
    } catch {
      // Silently fail — grid still works without connection status
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  const invalidateCache = useInvalidateGatewayCache();

  const handleConnected = useCallback(() => {
    fetchConnections();
    invalidateCache();
  }, [fetchConnections, invalidateCache]);

  useAppMessages({ onConnected: handleConnected, onConfigure: router.push });

  const openConnectPopup = (provider: string) => {
    const w = 520;
    const h = 700;
    const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
    window.open(
      `/app-connect/${provider}`,
      `connect-${provider}`,
      `width=${w},height=${h},left=${left},top=${top},scrollbars=yes,resizable=yes`,
    );
  };

  // Derived set for backward-compat with useConnectParam
  const connectedProviders = useMemo(
    () =>
      new Set(
        [...connectionCounts.entries()]
          .filter(([, count]) => count > 0)
          .map(([provider]) => provider),
      ),
    [connectionCounts],
  );

  // Handle ?connect=<provider> URL param
  useConnectParam({
    loading,
    connectedProviders,
    configuredProviders,
    envDefaultProviders,
    onConnect: setConnectApp,
    onConfigure: setConfigApp,
  });

  const handleConnect = (e: React.MouseEvent, app: AppDefinition) => {
    e.stopPropagation();
    const hasCredentials =
      envDefaultProviders.has(app.id) || configuredProviders.has(app.id);
    if (
      app.configurable?.fields &&
      !hasCredentials &&
      (connectionCounts.get(app.id) ?? 0) === 0
    ) {
      setConfigApp(app);
      return;
    }
    openConnectPopup(app.id);
  };

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <RequestAppSlot />
        {apps.map((app) => {
          const count = connectionCounts.get(app.id) ?? 0;
          return (
            <AppRow
              key={app.id}
              name={app.name}
              icon={app.icon}
              darkIcon={app.darkIcon}
              connectionCount={count}
              loading={loading}
              onConnect={(e) => handleConnect(e, app)}
              onClick={() => router.push(`/connections/apps/${app.id}`)}
            />
          );
        })}
      </div>

      {connectApp && (
        <ConnectAppDialog
          provider={connectApp.id}
          appName={connectApp.name}
          appIcon={connectApp.icon}
          appDarkIcon={connectApp.darkIcon}
          open={!!connectApp}
          onOpenChange={(open) => {
            if (!open) setConnectApp(null);
          }}
          onConnect={() => {
            const provider = connectApp.id;
            setConnectApp(null);
            openConnectPopup(provider);
          }}
        />
      )}

      {configApp?.configurable && (
        <ConfigureCredentialsDialog
          provider={configApp.id}
          appName={configApp.name}
          appIcon={configApp.icon}
          appDarkIcon={configApp.darkIcon}
          fields={configApp.configurable.fields}
          open={!!configApp}
          onOpenChange={(open) => {
            if (!open) setConfigApp(null);
          }}
          onConfigured={() => {
            const provider = configApp.id;
            setConfiguredProviders((prev) => new Set([...prev, provider]));
            setConfigApp(null);
            openConnectPopup(provider);
          }}
        />
      )}
    </>
  );
};

interface AppRowProps {
  name: string;
  icon: string;
  darkIcon?: string;
  connectionCount: number;
  loading: boolean;
  onConnect: (e: React.MouseEvent) => void;
  onClick: () => void;
}

const AppRow = ({
  name,
  icon,
  darkIcon,
  connectionCount,
  loading,
  onConnect,
  onClick,
}: AppRowProps) => {
  const connected = connectionCount > 0;
  return (
    <div
      className={cn(
        "group flex items-center justify-between rounded-xl border bg-card px-4 py-3 transition-colors cursor-pointer hover:bg-accent/50",
        connected && "border-brand/30",
      )}
      onClick={onClick}
    >
      <div className="flex items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <AppIcon icon={icon} darkIcon={darkIcon} name={name} />
        </div>
        <span className="text-sm font-medium">{name}</span>
      </div>

      <div className="flex items-center gap-2">
        {loading ? (
          <Skeleton className="h-6 w-16 rounded-md" />
        ) : connected ? (
          <div className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-brand" />
            <span className="text-xs font-medium text-brand">
              Connected{connectionCount > 1 ? ` (${connectionCount})` : ""}
            </span>
          </div>
        ) : (
          <Button size="xs" onClick={onConnect}>
            Connect
          </Button>
        )}
        <ChevronRight className="size-3.5 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
      </div>
    </div>
  );
};
