"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import { apps } from "@/lib/apps/registry";
import { getAppConnections } from "@/lib/actions/connections";
import { useAppConnected } from "@/hooks/use-app-connected";
import { AppIcon } from "./app-icon";

export const AppsTab = () => {
  const router = useRouter();
  const [connectedProviders, setConnectedProviders] = useState<Set<string>>(
    new Set(),
  );

  const fetchConnections = useCallback(async () => {
    try {
      const connections = await getAppConnections();
      setConnectedProviders(
        new Set(
          connections
            .filter((c) => c.status === "connected")
            .map((c) => c.provider),
        ),
      );
    } catch {
      // Silently fail — grid still works without connection status
    }
  }, []);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  useAppConnected(fetchConnections);

  const handleConnect = (e: React.MouseEvent, provider: string) => {
    e.stopPropagation();
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

  return (
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
            onConnect={(e) => handleConnect(e, app.id)}
            onClick={() => router.push(`/connections/apps/${app.id}`)}
          />
        );
      })}
    </div>
  );
};

interface AppRowProps {
  name: string;
  icon: string;
  darkIcon?: string;
  connected: boolean;
  onConnect: (e: React.MouseEvent) => void;
  onClick: () => void;
}

const AppRow = ({
  name,
  icon,
  darkIcon,
  connected,
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
        {connected ? (
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
