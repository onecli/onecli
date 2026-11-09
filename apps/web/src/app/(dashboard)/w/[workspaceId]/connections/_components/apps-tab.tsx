"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { WORKSPACE_PATH_RE, ORG_PATH_RE } from "@/lib/navigation";
import { useConnectionsHref } from "@/lib/settings-modal/use-connections-href";
import { useReplaceParam } from "@/lib/settings-modal/use-replace-param";
import { useSettingsModal } from "@/lib/settings-modal/modal-context";
import { openConnectPopup } from "@/lib/connect-popup";
import { ChevronRight, Search, X } from "lucide-react";
import { createPortal } from "react-dom";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { cn } from "@onecli/ui/lib/utils";
import {
  APP_CATEGORIES,
  CATEGORY_LABELS,
  type AppCategory,
} from "./app-categories";
import type { AppDefinition } from "@onecli/api/apps/types";
import { useQueryClient } from "@tanstack/react-query";
import type { PageScope } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { useConnections } from "@/hooks/use-connections";
import {
  useConfiguredProviders,
  useEnvDefaultProviders,
} from "@/hooks/use-app-config";
import { useAvailableApps } from "@/hooks/use-available-apps";
import { getApps } from "@onecli/api/apps/registry";
import { RequestAppSlot } from "@/lib/components/request-app-slot";
import {
  useAppMessages,
  type AppConnectedEvent,
} from "@/hooks/use-app-connected";
import { AppIcon } from "@/lib/components/app-icon";
import { ConnectAppDialog } from "./connect-app-dialog";
import { ConfigureCredentialsDialog } from "./configure-credentials-dialog";
import { GitHubAppConnectDialog } from "./github-app-connect-dialog";
import {
  GITHUB_APP_PROVIDER,
  useSharedGitHubInstallations,
} from "@/hooks/use-github-app-share";
import type { ConnectLinkAgent } from "@/lib/connect-link-agent";
import { useVerifiedConnectLinkAgent } from "@/hooks/use-verified-connect-link-agent";
import { useConnectParam } from "./use-connect-param";
import dynamic from "next/dynamic";
import { useInstance } from "@/hooks/use-instance";

// Licensed (granular_access): the Slack read-access finder. Lazy so the free
// build never evaluates it; rendered only when the instance is entitled.
const SlackReadTile = dynamic(() =>
  import("@/ee/slack-read/slack-read-tile").then((m) => m.SlackReadTile),
);

interface AppsTabProps {
  pageScope?: PageScope;
  basePath?: string;
  /** Where the search box renders, when the page has a better spot for it
   * than the filter row (the settings modal puts it in its tab strip, above
   * the strip's line). Omitted: the filter row keeps it. */
  searchSlot?: HTMLElement | null;
}

export const AppsTab = ({
  pageScope = "workspace",
  basePath,
  searchSlot,
}: AppsTabProps) => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const href = useConnectionsHref(basePath);
  const modal = useSettingsModal();
  const searchQuery = searchParams.get("q") ?? "";
  const [localSearch, setLocalSearch] = useState(searchQuery);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Intercept Ctrl/Cmd+F on the apps page to focus the search field instead of
  // the browser's native find. Mirrors the window keydown + cleanup pattern
  // used in the dashboard header.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only the bare Ctrl/Cmd+F chord triggers the browser's native find;
      // Shift/Alt variants mean other things, so don't hijack them.
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "f"
      ) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
  const activeCategory =
    (searchParams.get("category") as AppCategory | null) ?? "all";
  const [configApp, setConfigApp] = useState<AppDefinition | null>(null);
  // The agent a connect link named, held across the credentials setup a
  // not-yet-configured app needs first, so the connect after it is the
  // agent's too.
  const [linkConfigAgent, setLinkConfigAgent] = useState<
    ConnectLinkAgent | undefined
  >();
  const configAgent = useVerifiedConnectLinkAgent(linkConfigAgent);
  const [connectApp, setConnectApp] = useState<AppDefinition | null>(null);
  // The agent a connect link named: shown in the dialog, and the connect it
  // starts switches the new account on for it.
  const [linkAgent, setLinkAgent] = useState<ConnectLinkAgent | undefined>();
  // Shown and granted as the workspace's own record for the link's id.
  const connectAgent = useVerifiedConnectLinkAgent(linkAgent);
  // GitHub App: same as the app's own page, an installation already
  // connected elsewhere in the org is offered before a GitHub install.
  const [githubDialogOpen, setGithubDialogOpen] = useState(false);
  const { data: sharedInstallations = [] } =
    useSharedGitHubInstallations(pageScope);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestHostname, setRequestHostname] = useState("");
  const [requestAppName, setRequestAppName] = useState<string | undefined>();

  const updateParam = useReplaceParam();

  const queryClient = useQueryClient();
  const connectionsQuery = useConnections(pageScope);
  const configuredQuery = useConfiguredProviders(pageScope);
  const envDefaultsQuery = useEnvDefaultProviders();
  const availableQuery = useAvailableApps(pageScope);
  const connectionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of (connectionsQuery.data ?? []).filter(
      (c) => c.status === "connected",
    )) {
      counts.set(c.provider, (counts.get(c.provider) ?? 0) + 1);
    }
    return counts;
  }, [connectionsQuery.data]);
  const configuredProviders = useMemo(
    () => new Set(configuredQuery.data ?? []),
    [configuredQuery.data],
  );
  const envDefaultProviders = useMemo(
    () => new Set(envDefaultsQuery.data ?? []),
    [envDefaultsQuery.data],
  );
  const loading =
    connectionsQuery.isPending ||
    configuredQuery.isPending ||
    envDefaultsQuery.isPending;

  const handleConnected = useCallback(
    ({ provider, connectionId }: AppConnectedEvent) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connections.all() });
      // A credentials-import connect can implicitly save an app config.
      queryClient.invalidateQueries({
        queryKey: queryKeys.appConfig.configured(pageScope),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.counts.all() });
      if (provider) {
        // Hand a brand-new account to the detail page so it can offer agent
        // access on arrival: the popup's message is long gone by the time
        // that page mounts. A reconnect carries no id and just navigates.
        router.push(
          href(
            connectionId
              ? `/apps/${provider}?connected=${encodeURIComponent(connectionId)}`
              : `/apps/${provider}`,
          ),
        );
      }
    },
    [queryClient, pageScope, router, href],
  );

  useAppMessages({
    onConnected: handleConnected,
    onConfigure: (provider) => {
      router.push(href(`/apps/${provider}`));
    },
  });

  const openPopup = (
    provider: string,
    options?: { agentName?: string; agentId?: string; height?: number },
  ) =>
    openConnectPopup(provider, {
      ...options,
      workspaceId: pathname.match(WORKSPACE_PATH_RE)?.[1],
      // An org connect names its org. On the org routes the URL does; in
      // the Settings modal the URL beneath may name a workspace instead,
      // so the modal's resolved org is the source.
      orgId:
        pageScope === "organization"
          ? (modal?.organizationId ?? pathname.match(ORG_PATH_RE)?.[1])
          : undefined,
    });

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
    onConnect: useCallback((app: AppDefinition, agent?: ConnectLinkAgent) => {
      setConnectApp(app);
      setLinkAgent(agent);
    }, []),
    onConfigure: useCallback((app: AppDefinition, agent?: ConnectLinkAgent) => {
      setConfigApp(app);
      setLinkConfigAgent(agent);
    }, []),
    onRequestApp: useCallback((hostname: string, appName?: string) => {
      setRequestHostname(hostname);
      setRequestAppName(appName);
      setRequestOpen(true);
    }, []),
  });

  const availableApps = availableQuery.data;
  const filteredApps = useMemo(() => {
    let apps = [...getApps()].sort((a, b) => {
      const aConnected = (connectionCounts.get(a.id) ?? 0) > 0 ? 1 : 0;
      const bConnected = (connectionCounts.get(b.id) ?? 0) > 0 ? 1 : 0;
      return bConnected - aConnected;
    });

    // Availability (policy-engine step 7): when the org restricts availability,
    // hide the apps this workspace may not connect. `restricted:false` (an "open"
    // org, or OSS) leaves the picker unfiltered — no behavior change.
    if (availableApps?.restricted) {
      const allowed = new Set(availableApps.providers);
      apps = apps.filter((app) => allowed.has(app.id));
    }

    if (activeCategory !== "all") {
      apps = apps.filter((app) => APP_CATEGORIES[app.id] === activeCategory);
    }

    if (localSearch.trim()) {
      const q = localSearch.toLowerCase();
      apps = apps.filter((app) => app.name.toLowerCase().includes(q));
    }

    return apps;
  }, [connectionCounts, activeCategory, localSearch, availableApps]);

  const instance = useInstance();
  // Slack is not a registry app (the gateway never injects Slack creds), so
  // its tile is composed here: workspace scope, entitled, and only when the
  // current filter would show a Communication app named like it.
  const showSlackRead =
    pageScope === "workspace" &&
    instance?.entitled === true &&
    (activeCategory === "all" || activeCategory === "communication") &&
    (!localSearch.trim() || "slack".includes(localSearch.trim().toLowerCase()));

  const handleConnect = (
    e: React.MouseEvent | undefined,
    app: AppDefinition,
  ) => {
    e?.stopPropagation();
    const hasCredentials =
      envDefaultProviders.has(app.id) || configuredProviders.has(app.id);
    // Apps with an API-key alternate (Attio, Apollo, PostHog) can always
    // connect: the popup offers the key form when OAuth isn't configured or
    // isn't on the org's plan, so don't dead-end in the OAuth setup dialog.
    const hasApiKeyAlternate = (app.additionalMethods ?? []).some(
      (m) => m.type === "api_key",
    );
    if (
      app.configurable?.fields &&
      !hasCredentials &&
      !hasApiKeyAlternate &&
      (connectionCounts.get(app.id) ?? 0) === 0
    ) {
      setConfigApp(app);
      return;
    }
    if (app.id === GITHUB_APP_PROVIDER && sharedInstallations.length > 0) {
      setGithubDialogOpen(true);
      return;
    }
    const popupHeight =
      app.connectionMethod.type === "credentials_import" ? 820 : undefined;
    openPopup(app.id, { height: popupHeight });
  };

  const searchBox = (
    <div className="relative sm:shrink-0">
      <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
      <Input
        ref={searchInputRef}
        placeholder="Search apps…"
        value={localSearch}
        onChange={(e) => {
          setLocalSearch(e.target.value);
          updateParam("q", e.target.value || null);
        }}
        className="h-8 w-full bg-card pl-9 text-sm sm:w-52"
      />
      {localSearch && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setLocalSearch("");
            updateParam("q", null);
          }}
          className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2 transition-colors"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );

  return (
    <>
      {searchSlot && createPortal(searchBox, searchSlot)}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:gap-2">
        {/* One line, scrolling sideways when the page is narrow: a wrapped
            category reads as a second, separate filter. */}
        <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {CATEGORY_LABELS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => updateParam("category", id === "all" ? null : id)}
              className={cn(
                "shrink-0 rounded-md px-2.5 py-1 text-xs whitespace-nowrap transition-colors",
                activeCategory === id
                  ? "bg-brand-wash text-brand-ink font-medium"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {searchSlot === undefined && searchBox}
      </div>

      <div className="mt-4 grid auto-rows-fr gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* Always present, searching included: a search that finds nothing
            is exactly when someone wants to ask for the app. */}
        <RequestAppSlot
          requestOpen={requestOpen}
          onRequestOpenChange={setRequestOpen}
          initialName={requestAppName ?? (localSearch.trim() || undefined)}
          initialUrl={requestHostname}
        />
        {loading ? (
          Array.from({ length: 12 }, (_, i) => (
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
        ) : filteredApps.length === 0 && !showSlackRead ? (
          <div className="col-span-full flex flex-col items-center justify-center py-12 text-center">
            <p className="text-muted-foreground text-sm">
              No apps match your search.
            </p>
            <button
              type="button"
              onClick={() => {
                setLocalSearch("");
                updateParam("q", null);
                updateParam("category", null);
              }}
              className="text-brand mt-2 text-sm font-medium hover:underline"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <>
            {showSlackRead && <SlackReadTile />}
            {filteredApps.map((app) => {
              const count = connectionCounts.get(app.id) ?? 0;
              return (
                <AppRow
                  key={app.id}
                  name={app.name}
                  icon={app.icon}
                  darkIcon={app.darkIcon}
                  description={app.description}
                  category={categoryLabel(app.id)}
                  connectionCount={count}
                  onConnect={(e) => handleConnect(e, app)}
                  onClick={() => router.push(href(`/apps/${app.id}`))}
                />
              );
            })}
          </>
        )}
      </div>

      {connectApp && (
        <ConnectAppDialog
          appName={connectApp.name}
          appIcon={connectApp.icon}
          appDarkIcon={connectApp.darkIcon}
          agentName={connectAgent?.name}
          open={!!connectApp}
          onOpenChange={(open) => {
            if (!open) {
              setConnectApp(null);
              setLinkAgent(undefined);
            }
          }}
          onConnect={() => {
            const provider = connectApp.id;
            const agent = connectAgent;
            setConnectApp(null);
            setLinkAgent(undefined);
            openPopup(provider, { agentName: agent?.name, agentId: agent?.id });
          }}
        />
      )}

      <GitHubAppConnectDialog
        open={githubDialogOpen}
        onOpenChange={setGithubDialogOpen}
        agentId={connectAgent?.id}
        pageScope={pageScope}
        onInstallNew={() =>
          openPopup(GITHUB_APP_PROVIDER, {
            agentId: connectAgent?.id,
            agentName: connectAgent?.name,
          })
        }
        onConnected={() => router.push(href(`/apps/${GITHUB_APP_PROVIDER}`))}
      />

      {configApp?.configurable && (
        <ConfigureCredentialsDialog
          provider={configApp.id}
          appName={configApp.name}
          appIcon={configApp.icon}
          appDarkIcon={configApp.darkIcon}
          fields={configApp.configurable.fields}
          hint={configApp.configurable.hint}
          setupGuideUrl={configApp.setupGuideUrl}
          open={!!configApp}
          onOpenChange={(open) => {
            if (!open) {
              setConfigApp(null);
              setLinkConfigAgent(undefined);
            }
          }}
          pageScope={pageScope}
          onConfigured={() => {
            const provider = configApp.id;
            const agent = configAgent;
            setConfigApp(null);
            setLinkConfigAgent(undefined);
            openPopup(provider, { agentName: agent?.name, agentId: agent?.id });
          }}
        />
      )}
    </>
  );
};

/** The chip label of the category an app is filed under, if any. */
const categoryLabel = (appId: string) =>
  CATEGORY_LABELS.find(({ id }) => id === APP_CATEGORIES[appId])?.label;

interface AppRowProps {
  name: string;
  icon: string;
  darkIcon?: string;
  description?: string;
  category?: string;
  connectionCount: number;
  onConnect: (e: React.MouseEvent) => void;
  onClick: () => void;
}

const AppRow = ({
  name,
  icon,
  darkIcon,
  description,
  category,
  connectionCount,
  onConnect,
  onClick,
}: AppRowProps) => {
  const connected = connectionCount > 0;
  return (
    <div
      className={cn(
        "group flex cursor-pointer flex-col gap-2 rounded-lg border bg-card px-3.5 py-3 transition-colors hover:border-foreground/20 has-[button:hover]:border-border!",
        connected && "border-brand/30",
      )}
      onClick={onClick}
    >
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background dark:border-white/10 dark:bg-white/10">
          <AppIcon icon={icon} darkIcon={darkIcon} name={name} />
        </div>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {name}
        </span>
        {category && (
          <span className="bg-secondary text-muted-foreground shrink-0 rounded-md px-1.5 py-0.5 text-[11px]">
            {category}
          </span>
        )}
      </div>
      {description && (
        <p className="text-muted-foreground line-clamp-2 text-xs leading-snug">
          {description}
        </p>
      )}
      <div className="mt-auto flex items-center justify-between gap-2">
        {connected ? (
          <div className="flex items-baseline gap-1.5">
            <span className="text-brand-ink text-xs font-medium">
              Connected
            </span>
            {connectionCount > 1 && (
              <span className="text-[11px] text-muted-foreground">
                {connectionCount} accounts
              </span>
            )}
          </div>
        ) : (
          <Button size="xs" variant="outline" onClick={onConnect}>
            Connect
          </Button>
        )}
        <span className="text-muted-foreground flex items-center gap-0.5 text-[11px] transition-colors group-hover:text-foreground group-has-[button:hover]:text-muted-foreground">
          View details
          <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5 group-has-[button:hover]:translate-x-0" />
        </span>
      </div>
    </div>
  );
};
