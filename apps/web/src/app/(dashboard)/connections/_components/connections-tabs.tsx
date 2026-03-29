"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAppConnected } from "@/hooks/use-app-connected";
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

const TAB_ROUTES: Record<string, string> = {
  apps: "/connections",
  secrets: "/connections/secrets",
  vaults: "/connections/vaults",
  connected: "/connections/connected",
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
  const [connectedCount, setConnectedCount] = useState(0);

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

  useAppConnected(fetchCount);

  const handleTabChange = (value: string) => {
    const href = TAB_ROUTES[value];
    if (href) router.push(href);
  };

  return (
    <AnimatedTabs defaultValue={activeTab} onValueChange={handleTabChange}>
      <AnimatedTabList className="justify-between">
        <div className="flex">
          <AnimatedTabTrigger value="apps">Apps</AnimatedTabTrigger>
          <AnimatedTabTrigger value="secrets">Secrets</AnimatedTabTrigger>
          <AnimatedTabTrigger value="vaults">
            External Vaults
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
