"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { cn } from "@onecli/ui/lib/utils";
import { apps } from "@/lib/apps/registry";
import type { AppDefinition } from "@/lib/apps/types";
import { getAppConnections } from "@/lib/actions/connections";
import {
  checkAppConfigExists,
  getAvailableEnvDefaults,
} from "@/lib/actions/app-config";
import { useAppMessages } from "@/hooks/use-app-connected";
import { AppIcon } from "./app-icon";
import { ConnectAppDialog } from "./connect-app-dialog";
import { ConfigureCredentialsDialog } from "./configure-credentials-dialog";
import { useConnectParam } from "./use-connect-param";

export const AppsTab = () => {
  const router = useRouter();
  const [connectedProviders, setConnectedProviders] = useState<Set<string>>(
    () => new Set(),
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
      const [connections, availableDefaults] = await Promise.all([
        getAppConnections(),
        getAvailableEnvDefaults(),
      ]);
      setConnectedProviders(
        new Set(
          connections
            .filter((c) => c.status === "connected")
            .map((c) => c.provider),
        ),
      );
      setEnvDefaultProviders(new Set(availableDefaults));
      const byocApps = apps.filter(
        (a) => a.configurable && !a.configurable.envDefaults,
      );
      const configured = await Promise.all(
        byocApps.map(async (a) => {
          const exists = await checkAppConfigExists(a.id).catch(() => false);
          return exists ? a.id : null;
        }),
      );
      setConfiguredProviders(
        new Set(configured.filter((id): id is string => id !== null)),
      );
    } catch {
      // Silently fail — grid still works without connection status
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  useAppMessages({ onConnected: fetchConnections, onConfigure: router.push });

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
      !connectedProviders.has(app.id)
    ) {
      setConfigApp(app);
      return;
    }
    openConnectPopup(app.id);
  };

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {apps.map((app) => {
          const isConnected = connectedProviders.has(app.id);
          return (
            <AppRow
              key={app.id}
              name={app.name}
              icon={app.icon}
              darkIcon={app.darkIcon}
              connected={isConnected}
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
  connected: boolean;
  loading: boolean;
  onConnect: (e: React.MouseEvent) => void;
  onClick: () => void;
}

const AppRow = ({
  name,
  icon,
  darkIcon,
  connected,
  loading,
  onConnect,
  onClick,
}: AppRowProps) => {
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
            <span className="text-xs font-medium text-brand">Connected</span>
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
