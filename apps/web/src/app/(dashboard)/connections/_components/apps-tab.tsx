"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  PROJECT_PATH_RE,
  ORG_PATH_RE,
  withProjectPrefix,
} from "@/lib/navigation";
import { ChevronRight } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { cn } from "@onecli/ui/lib/utils";
import type { AppDefinition } from "@onecli/api/apps/types";
import type { getAppConnections as defaultGetConnections } from "@/lib/actions/connections";
import { apiGet } from "@/lib/api";
import {
  getConfiguredProviders as defaultGetConfiguredProviders,
  getAvailableEnvDefaults,
} from "@/lib/actions/app-config";
import { getApps } from "@onecli/api/apps/registry";
import { RequestAppSlot } from "@/lib/components/request-app-slot";
import { useAppMessages } from "@/hooks/use-app-connected";
import { useInvalidateGatewayCache } from "@/hooks/use-invalidate-cache";
import { getCurrentPlan } from "@/lib/user-plan";
import { ProAppDialog } from "@/lib/components/pro-app-dialog";
import { AppIcon } from "./app-icon";
import { ConnectAppDialog } from "./connect-app-dialog";
import { ConfigureCredentialsDialog } from "./configure-credentials-dialog";
import { useConnectParam } from "./use-connect-param";

const defaultGetConnections_ = () =>
  apiGet<{ connections: Awaited<ReturnType<typeof defaultGetConnections>> }>(
    "/v1/apps/connections",
  ).then((r) => r.connections);

interface AppsTabProps {
  getConnections?: typeof defaultGetConnections;
  getConfiguredProviders?: typeof defaultGetConfiguredProviders;
  pageScope?: "project" | "organization";
  basePath?: string;
}

export const AppsTab = ({
  getConnections = defaultGetConnections_,
  getConfiguredProviders = defaultGetConfiguredProviders,
  pageScope = "project",
  basePath,
}: AppsTabProps) => {
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
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestHostname, setRequestHostname] = useState("");
  const [requestAppName, setRequestAppName] = useState<string | undefined>();

  const fetchConnections = useCallback(async () => {
    try {
      const [connections, availableDefaults, configured, currentPlan] =
        await Promise.all([
          getConnections(),
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
  }, [getConnections, getConfiguredProviders]);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  const invalidateCache = useInvalidateGatewayCache();

  const handleConnected = useCallback(
    ({ provider }: { provider?: string }) => {
      fetchConnections();
      invalidateCache();
      if (provider) {
        router.push(
          basePath
            ? `${basePath}/apps/${provider}`
            : withProjectPrefix(pathname, `/connections/apps/${provider}`),
        );
      }
    },
    [fetchConnections, invalidateCache, router, basePath, pathname],
  );

  useAppMessages({ onConnected: handleConnected, onConfigure: router.push });

  const openConnectPopup = (
    provider: string,
    options?: { agentName?: string; height?: number },
  ) => {
    const w = 520;
    const h = options?.height ?? 700;
    const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
    const searchParams = new URLSearchParams();
    if (options?.agentName) searchParams.set("agent_name", options.agentName);
    const projectMatch = pathname.match(PROJECT_PATH_RE)?.[1];
    if (projectMatch) searchParams.set("projectId", projectMatch);
    if (pageScope === "organization") {
      const orgMatch = pathname.match(ORG_PATH_RE)?.[1];
      if (orgMatch) searchParams.set("orgId", orgMatch);
    }
    const qs = searchParams.toString();
    window.open(
      `/app-connect/${provider}${qs ? `?${qs}` : ""}`,
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

  // Handle ?connect=<provider> and ?request=<hostname> URL params
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
    onRequestApp: useCallback((hostname: string, appName?: string) => {
      setRequestHostname(hostname);
      setRequestAppName(appName);
      setRequestOpen(true);
    }, []),
  });

  const sortedApps = useMemo(
    () =>
      [...getApps()].sort((a, b) => {
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
        <RequestAppSlot
          requestOpen={requestOpen}
          onRequestOpenChange={setRequestOpen}
          initialName={requestAppName}
          initialUrl={requestHostname}
        />
        {loading
          ? Array.from({ length: 12 }, (_, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-xl border bg-card px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <Skeleton className="size-9 rounded-lg" />
                  <Skeleton className="h-4 w-24 rounded" />
                </div>
                <Skeleton className="h-7 w-16 rounded-md" />
              </div>
            ))
          : sortedApps.map((app) => {
              const count = connectionCounts.get(app.id) ?? 0;
              const isLocked =
                !app.available || (app.teamOnly === true && plan !== "team");
              return (
                <AppRow
                  key={app.id}
                  name={app.name}
                  icon={app.icon}
                  darkIcon={app.darkIcon}
                  connectionCount={count}
                  cloudOnly={isLocked}
                  onConnect={(e) => handleConnect(e, app)}
                  onClick={
                    isLocked
                      ? () => setProApp(app)
                      : () =>
                          router.push(
                            basePath
                              ? `${basePath}/apps/${app.id}`
                              : withProjectPrefix(
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
  cloudOnly?: boolean;
  onConnect: (e: React.MouseEvent) => void;
  onClick: () => void;
}

const AppRow = ({
  name,
  icon,
  darkIcon,
  connectionCount,
  cloudOnly,
  onConnect,
  onClick,
}: AppRowProps) => {
  const connected = connectionCount > 0;
  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-xl border bg-card px-4 py-3.5 transition-colors cursor-pointer hover:bg-accent/50 has-[button:hover]:bg-card!",
        connected && "border-brand/30",
      )}
      onClick={onClick}
    >
      <div className="flex flex-1 items-center gap-3 min-w-0">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <AppIcon icon={icon} darkIcon={darkIcon} name={name} />
        </div>
        <div className="min-w-0">
          <span className="text-sm font-medium">{name}</span>
          {!cloudOnly && (
            <p className="text-[11px] text-muted-foreground group-hover:underline group-hover:text-foreground group-has-[button:hover]:no-underline group-has-[button:hover]:text-muted-foreground transition-colors">
              View details
            </p>
          )}
        </div>
      </div>

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
            Team
          </span>
        </span>
      ) : (
        <div className="flex items-center gap-2 shrink-0">
          <ChevronRight className="size-4 text-muted-foreground transition-all group-hover:text-foreground group-hover:translate-x-0.5 group-has-[button:hover]:text-muted-foreground group-has-[button:hover]:translate-x-0" />
          <div className="border-l pl-2 min-w-20 flex justify-center">
            {connected ? (
              <div className="flex flex-col items-center">
                <span className="text-xs font-medium text-brand">
                  Connected
                </span>
                {connectionCount > 1 && (
                  <span className="text-[11px] text-muted-foreground">
                    {connectionCount} accounts
                  </span>
                )}
              </div>
            ) : (
              <Button size="xs" onClick={onConnect}>
                Connect
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
