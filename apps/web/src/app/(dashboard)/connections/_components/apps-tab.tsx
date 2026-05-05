"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { withProjectPrefix } from "@/lib/navigation";
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
import { getCurrentPlan } from "@/lib/user-plan";
import { ProAppDialog } from "@/lib/components/pro-app-dialog";
import { AppIcon } from "./app-icon";
import { ConnectAppDialog } from "./connect-app-dialog";
import { ConfigureCredentialsDialog } from "./configure-credentials-dialog";
import { useConnectParam } from "./use-connect-param";

export const AppsTab = () => {
  const router = useRouter();
  const pathname = usePathname();
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
  const [connectAgentName, setConnectAgentName] = useState<
    string | undefined
  >();
  const [premiumApp, setProApp] = useState<AppDefinition | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchConnections = useCallback(async () => {
    try {
      const [connections, availableDefaults, configured, currentPlan] =
        await Promise.all([
          getAppConnections(),
          getAvailableEnvDefaults(),
          getConfiguredProviders().catch(() => [] as string[]),
          getCurrentPlan(),
        ]);
      const counts = new Map<string, number>();
      for (const c of connections.filter((c) => c.status === "connected")) {
        counts.set(c.provider, (counts.get(c.provider) ?? 0) + 1);
      }
      setConnectionCounts(counts);
      setEnvDefaultProviders(new Set(availableDefaults));
      setConfiguredProviders(new Set(configured));
      setPlan(currentPlan);
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

  const openConnectPopup = (
    provider: string,
    options?: { agentName?: string; height?: number },
  ) => {
    const w = 520;
    const h = options?.height ?? 700;
    const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
    const params = options?.agentName
      ? `?agent_name=${encodeURIComponent(options.agentName)}`
      : "";
    window.open(
      `/app-connect/${provider}${params}`,
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
    onConnect: useCallback((app: AppDefinition, agentName?: string) => {
      setConnectApp(app);
      setConnectAgentName(agentName);
    }, []),
    onConfigure: setConfigApp,
  });

  const sortedApps = useMemo(
    () =>
      [...apps].sort((a, b) => {
        const aConnected = (connectionCounts.get(a.id) ?? 0) > 0 ? 1 : 0;
        const bConnected = (connectionCounts.get(b.id) ?? 0) > 0 ? 1 : 0;
        return bConnected - aConnected;
      }),
    [connectionCounts],
  );

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
    const popupHeight =
      app.connectionMethod.type === "credentials_import" ? 820 : undefined;
    openConnectPopup(app.id, { height: popupHeight });
  };

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <RequestAppSlot />
        {sortedApps.map((app) => {
          const count = connectionCounts.get(app.id) ?? 0;
          const isCloudOnly = app.connectionMethod.type === "cloud_only";
          const isLocked = isCloudOnly || (app.pro && plan !== "team");
          return (
            <AppRow
              key={app.id}
              name={app.name}
              icon={app.icon}
              darkIcon={app.darkIcon}
              connectionCount={count}
              loading={loading}
              cloudOnly={isLocked}
              onConnect={(e) => handleConnect(e, app)}
              onClick={
                isLocked
                  ? () => setProApp(app)
                  : () =>
                      router.push(
                        withProjectPrefix(
                          pathname,
                          `/connections/apps/${app.id}`,
                        ),
                      )
              }
            />
          );
        })}
      </div>

      {connectApp && (
        <ConnectAppDialog
          appName={connectApp.name}
          appIcon={connectApp.icon}
          appDarkIcon={connectApp.darkIcon}
          agentName={connectAgentName}
          open={!!connectApp}
          onOpenChange={(open) => {
            if (!open) {
              setConnectApp(null);
              setConnectAgentName(undefined);
            }
          }}
          onConnect={() => {
            const provider = connectApp.id;
            const agent = connectAgentName;
            setConnectApp(null);
            setConnectAgentName(undefined);
            openConnectPopup(provider, { agentName: agent });
          }}
        />
      )}

      {premiumApp && (
        <ProAppDialog
          appName={premiumApp.name}
          appIcon={premiumApp.icon}
          appDarkIcon={premiumApp.darkIcon}
          description={premiumApp.description}
          open={!!premiumApp}
          onOpenChange={(open) => {
            if (!open) setProApp(null);
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
          hint={configApp.configurable.hint}
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
  cloudOnly?: boolean;
  onConnect: (e: React.MouseEvent) => void;
  onClick: () => void;
}

const AppRow = ({
  name,
  icon,
  darkIcon,
  connectionCount,
  loading,
  cloudOnly,
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
        {cloudOnly ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/20 bg-brand/5 px-2.5 py-0.5">
            <svg
              width="11"
              height="9"
              viewBox="0 0 44 36"
              fill="none"
              className="shrink-0 -mt-px"
            >
              <path
                d="M2 2L16 18L2 34"
                stroke="currentColor"
                strokeWidth="5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-brand"
              />
              <path
                d="M22 2L36 18L22 34"
                stroke="currentColor"
                strokeWidth="5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-brand"
              />
            </svg>
            <span className="text-[11px] font-semibold tracking-wide text-brand">
              Pro
            </span>
          </span>
        ) : loading ? (
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
        {cloudOnly ? null : (
          <ChevronRight className="size-3.5 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
        )}
      </div>
    </div>
  );
};
