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
  getAppConnections,
  getVaultConnections,
} from "@/lib/actions/connections";
import { getSecrets } from "@/lib/actions/secrets";

/**
 * Derive tab URLs from the current pathname so navigation stays inside the
 * current prefix. In OSS the prefix is `/connections`; in cloud's project
 * routes it's `/p/<projectId>/connections`. Without this, clicking "Secrets"
 * inside a project would jump to the OSS `/connections/secrets` URL and lose
 * the project scope.
 */
const getTabRoutes = (pathname: string): Record<string, string> => {
  const idx = pathname.indexOf("/connections");
  const base =
    idx >= 0 ? pathname.slice(0, idx + "/connections".length) : "/connections";
  return {
    apps: base,
    secrets: `${base}/secrets`,
    vaults: `${base}/vaults`,
    connected: `${base}/connected`,
  };
};

const pathToTab = (pathname: string): string => {
  const segment = pathname.split("/connections")[1]?.replace(/^\//, "") || "";
  if (segment === "secrets") return "secrets";
  if (segment === "vaults") return "vaults";
  if (segment === "connected") return "connected";
  return "apps";
};

export const ConnectionsTabs = () => {
  const pathname = usePathname();
  const router = useRouter();
  const activeTab = pathToTab(pathname);
  const tabRoutes = getTabRoutes(pathname);
  const [connectedCount, setConnectedCount] = useState(0);
  const [, startTransition] = useTransition();

  const fetchCount = useCallback(async () => {
    try {
      const [connections, secrets, vaults] = await Promise.all([
        getAppConnections(),
        getSecrets(),
        getVaultConnections(),
      ]);
      const appCount = connections.filter(
        (c) => c.status === "connected",
      ).length;
      setConnectedCount(appCount + secrets.length + vaults.length);
    } catch {
      // Keep count at 0
    }
  }, []);

  useEffect(() => {
    fetchCount();
  }, [fetchCount]);

  // Prefetch all tab routes so navigation is instant.
  // Depend on pathname (primitive) rather than tabRoutes (new object each render).
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
          <AnimatedTabTrigger value="secrets">Secrets</AnimatedTabTrigger>
          <AnimatedTabTrigger value="vaults">
            <span className="sm:hidden">Vaults</span>
            <span className="hidden sm:inline">External Vaults</span>
          </AnimatedTabTrigger>
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
