"use client";

import { useMemo, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppMessages } from "@/hooks/use-app-connected";
import { connectionsPath } from "@/lib/navigation";
import {
  AnimatedTabs,
  AnimatedTabList,
  AnimatedTabTrigger,
} from "@onecli/ui/components/animated-tabs";
import { Badge } from "@onecli/ui/components/badge";
import { secrets as secretsApi, type PageScope } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { useConnections, useVaultConnections } from "@/hooks/use-connections";

const getTabRoutes = (pathname: string): Record<string, string> => {
  const idx = pathname.indexOf("/connections");
  const base =
    idx >= 0 ? pathname.slice(0, idx + "/connections".length) : "/connections";
  return {
    apps: base,
    custom: `${base}/custom`,
    llms: `${base}/llms`,
    vaults: `${base}/vaults`,
    connected: `${base}/connected`,
  };
};

const pathToTab = (pathname: string): string => {
  const segment = pathname.split("/connections")[1]?.replace(/^\//, "") || "";
  if (segment === "custom") return "custom";
  if (segment === "llms") return "llms";
  if (segment === "vaults") return "vaults";
  if (segment === "connected") return "connected";
  return "apps";
};

interface ConnectionsTabsProps {
  getSecrets?: () => Promise<unknown[]>;
  showVaults?: boolean;
  basePath?: string;
  pageScope?: PageScope;
}

export const ConnectionsTabs = ({
  getSecrets,
  showVaults = true,
  basePath,
  pageScope = "project",
}: ConnectionsTabsProps) => {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const activeTab = basePath
    ? pathToTab(pathname.replace(basePath, "/connections"))
    : pathToTab(pathname);
  const tabRoutes = basePath
    ? {
        apps: basePath,
        custom: `${basePath}/custom`,
        llms: `${basePath}/llms`,
        vaults: `${basePath}/vaults`,
        connected: `${basePath}/connected`,
      }
    : getTabRoutes(pathname);
  const [, startTransition] = useTransition();

  const { data: connectionsList = [] } = useConnections(pageScope);
  const { data: secretsList = [] } = useQuery({
    queryKey: [...queryKeys.secrets.list(), pageScope],
    queryFn: getSecrets ?? secretsApi.list,
  });
  const { data: vaultsList = [] } = useVaultConnections(
    showVaults && pageScope === "project",
  );

  const connectedCount = useMemo(() => {
    const appCount = connectionsList.filter(
      (c) => c.status === "connected",
    ).length;
    return appCount + secretsList.length + (showVaults ? vaultsList.length : 0);
  }, [connectionsList, secretsList, vaultsList, showVaults]);

  useAppMessages({
    onConnected: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connections.all() });
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.all() });
    },
    onConfigure: (provider) =>
      router.push(connectionsPath({ pathname, basePath }, `/apps/${provider}`)),
  });

  const handleTabChange = (value: string) => {
    const href = tabRoutes[value];
    if (href) startTransition(() => router.push(href));
  };

  return (
    <AnimatedTabs value={activeTab} onValueChange={handleTabChange}>
      <AnimatedTabList className="sm:justify-between">
        <div className="flex">
          <AnimatedTabTrigger value="apps">Apps</AnimatedTabTrigger>
          <AnimatedTabTrigger value="custom">Custom</AnimatedTabTrigger>
          <AnimatedTabTrigger value="llms">LLMs</AnimatedTabTrigger>
          {showVaults && (
            <AnimatedTabTrigger value="vaults">
              <span className="sm:hidden">Vaults</span>
              <span className="hidden sm:inline">External Vaults</span>
            </AnimatedTabTrigger>
          )}
        </div>
        <AnimatedTabTrigger
          value="connected"
          className="flex items-center gap-2"
        >
          Connected
          {connectedCount > 0 && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              {connectedCount}
            </Badge>
          )}
        </AnimatedTabTrigger>
      </AnimatedTabList>
    </AnimatedTabs>
  );
};
