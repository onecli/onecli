"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAppMessages } from "@/hooks/use-app-connected";
import {
  AnimatedTabs,
  AnimatedTabList,
  AnimatedTabTrigger,
} from "@onecli/ui/components/animated-tabs";
import { Badge } from "@onecli/ui/components/badge";
import {
  getAppConnections as defaultGetConnections,
  getVaultConnections as defaultGetVaultConnections,
} from "@/lib/actions/connections";
import { getSecrets as defaultGetSecrets } from "@/lib/actions/secrets";

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
  getConnections?: typeof defaultGetConnections;
  getSecrets?: typeof defaultGetSecrets;
  getVaultConnections?: typeof defaultGetVaultConnections | null;
  showVaults?: boolean;
  basePath?: string;
}

export const ConnectionsTabs = ({
  getConnections = defaultGetConnections,
  getSecrets = defaultGetSecrets,
  getVaultConnections = defaultGetVaultConnections,
  showVaults = true,
  basePath,
}: ConnectionsTabsProps) => {
  const pathname = usePathname();
  const router = useRouter();
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
  const [connectedCount, setConnectedCount] = useState(0);
  const [, startTransition] = useTransition();

  const fetchCount = useCallback(async () => {
    try {
      const [connections, secrets, vaults] = await Promise.all([
        getConnections(),
        getSecrets(),
        getVaultConnections ? getVaultConnections() : Promise.resolve([]),
      ]);
      const appCount = connections.filter(
        (c) => c.status === "connected",
      ).length;
      setConnectedCount(appCount + secrets.length + vaults.length);
    } catch {
      // Keep count at 0
    }
  }, [getConnections, getSecrets, getVaultConnections]);

  useEffect(() => {
    fetchCount();
  }, [fetchCount]);

  useEffect(() => {
    Object.values(tabRoutes).forEach((route) => router.prefetch(route));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, pathname]);

  useAppMessages({ onConnected: fetchCount, onConfigure: router.push });

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
