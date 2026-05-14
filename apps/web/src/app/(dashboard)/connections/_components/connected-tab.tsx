"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { withProjectPrefix } from "@/lib/navigation";
import { ChevronRight, KeyRound } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Card } from "@onecli/ui/components/card";
import { cn } from "@onecli/ui/lib/utils";
import { Skeleton } from "@onecli/ui/components/skeleton";
import {
  getAppConnections as defaultGetConnections,
  getVaultConnections as defaultGetVaultConnections,
} from "@/lib/actions/connections";
import { getSecrets as defaultGetSecrets } from "@/lib/actions/secrets";
import { getApp } from "@onecli/api/apps/registry";
import { useAppMessages } from "@/hooks/use-app-connected";
import { extractLabel } from "@onecli/api/services/connection-service";
import { AppIcon } from "./app-icon";
import { SecretDialog } from "./secret-dialog";
import type { SecretActions } from "./types";

interface ConnectedItem {
  id: string;
  name: string;
  label?: string | null;
  icon: string | null;
  darkIcon?: string;
  type: "app" | "secret" | "vault";
  typeLabel: string;
  detail: string;
  providerCount?: number;
  href?: string;
  inherited?: boolean;
  secretData?: {
    id: string;
    name: string;
    type: string;
    typeLabel: string;
    hostPattern: string;
    pathPattern: string | null;
    injectionConfig: unknown;
    isPlatform: boolean;
    createdAt: Date;
  };
}

interface ConnectedTabProps {
  getConnections?: typeof defaultGetConnections;
  getSecrets?: typeof defaultGetSecrets;
  getVaultConnections?: typeof defaultGetVaultConnections | null;
  basePath?: string;
  secretActions?: SecretActions;
  pageScope?: "project" | "organization";
}

export const ConnectedTab = ({
  getConnections = defaultGetConnections,
  getSecrets = defaultGetSecrets,
  getVaultConnections = defaultGetVaultConnections,
  basePath,
  secretActions,
  pageScope = "project",
}: ConnectedTabProps) => {
  const router = useRouter();
  const pathname = usePathname();
  const [items, setItems] = useState<ConnectedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingSecret, setEditingSecret] = useState<
    ConnectedItem["secretData"] | null
  >(null);

  const fetchItems = useCallback(async () => {
    try {
      const [connections, secrets, vaults] = await Promise.all([
        getConnections(),
        getSecrets(),
        getVaultConnections ? getVaultConnections() : Promise.resolve([]),
      ]);

      const connectedApps = connections.filter((c) => c.status === "connected");
      const providerCounts = new Map<string, number>();
      connectedApps.forEach((c) =>
        providerCounts.set(
          c.provider,
          (providerCounts.get(c.provider) ?? 0) + 1,
        ),
      );

      const appItems: ConnectedItem[] = connectedApps.map((c) => {
        const appDef = getApp(c.provider);
        const metadata = c.metadata as Record<string, unknown> | null;
        const label = c.label ?? extractLabel(metadata ?? undefined);
        const baseName = appDef?.name ?? c.provider;
        const hasMultiple = (providerCounts.get(c.provider) ?? 0) > 1;
        const isInherited = !!c.scope && c.scope !== pageScope;
        return {
          id: `app-${c.id}`,
          name: hasMultiple && label ? `${baseName} - ${label}` : baseName,
          label,
          icon: appDef?.icon ?? null,
          darkIcon: appDef?.darkIcon,
          type: "app" as const,
          typeLabel: isInherited
            ? "Organization"
            : appDef?.connectionMethod.type === "oauth"
              ? "OAuth"
              : appDef?.connectionMethod.type === "credentials_import"
                ? "Credentials"
                : "API Key",
          detail: label
            ? `Connected as ${label}`
            : `${c.scopes.length} scope${c.scopes.length !== 1 ? "s" : ""} granted`,
          href: basePath
            ? `${basePath}/apps/${c.provider}`
            : withProjectPrefix(pathname, `/connections/apps/${c.provider}`),
          providerCount: hasMultiple
            ? providerCounts.get(c.provider)
            : undefined,
          inherited: isInherited,
        };
      });

      const secretItems: ConnectedItem[] = secrets.map((s) => {
        const isInherited = !!s.scope && s.scope !== pageScope;
        return {
          id: `secret-${s.id}`,
          name: s.name,
          icon: null,
          type: "secret" as const,
          typeLabel: isInherited ? "Organization" : s.typeLabel,
          detail: `Host: ${s.hostPattern}`,
          inherited: isInherited,
          secretData: isInherited ? undefined : s,
        };
      });

      const vaultItems: ConnectedItem[] = vaults.map((v) => ({
        id: `vault-${v.provider}`,
        name:
          v.name ?? v.provider.charAt(0).toUpperCase() + v.provider.slice(1),
        icon: `/icons/${v.provider}.svg`,
        type: "vault" as const,
        typeLabel: "External Vault",
        detail: v.status === "connected" ? "Connected" : "Paired",
        href: basePath
          ? `${basePath}/vaults/${v.provider}`
          : withProjectPrefix(pathname, `/connections/vaults/${v.provider}`),
      }));

      setItems([...appItems, ...secretItems, ...vaultItems]);
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, [
    pathname,
    basePath,
    getConnections,
    getSecrets,
    getVaultConnections,
    pageScope,
  ]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  useAppMessages({ onConnected: fetchItems, onConfigure: router.push });

  const handleItemClick = (item: ConnectedItem) => {
    if (item.inherited) return;
    if (item.secretData) {
      setEditingSecret(item.secretData);
    } else if (item.href) {
      router.push(item.href);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <Card key={i} className="p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Skeleton className="size-9 rounded-lg" />
                <div className="space-y-1.5">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-44" />
                </div>
              </div>
              <Skeleton className="h-5 w-20 rounded-md" />
            </div>
          </Card>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-sm text-muted-foreground">
          No connected services yet. Head to the{" "}
          <button
            onClick={() =>
              router.push(
                basePath ?? withProjectPrefix(pathname, "/connections"),
              )
            }
            className="text-brand hover:underline font-medium"
          >
            Apps
          </button>{" "}
          tab to get started.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-3">
        {items.map((item) => (
          <Card
            key={item.id}
            className={cn(
              "group p-4 transition-colors",
              item.inherited
                ? "opacity-60 border-dashed"
                : "cursor-pointer hover:bg-accent/50",
            )}
            onClick={item.inherited ? undefined : () => handleItemClick(item)}
          >
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  {item.icon ? (
                    <AppIcon
                      icon={item.icon}
                      darkIcon={item.darkIcon}
                      name={item.name}
                    />
                  ) : (
                    <KeyRound className="size-4 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-medium truncate">{item.name}</h3>
                  <p className="text-muted-foreground text-xs mt-0.5 truncate">
                    <span className="text-muted-foreground/60">
                      {item.typeLabel}
                    </span>
                    <span className="mx-1.5 text-muted-foreground/30">·</span>
                    {item.detail}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {item.inherited ? (
                  <Badge variant="outline" className="text-[10px]">
                    Organization
                  </Badge>
                ) : (
                  <>
                    <div className="flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-brand" />
                      <span className="text-xs text-brand font-medium">
                        {item.type === "secret"
                          ? "Active"
                          : item.providerCount
                            ? `Connected (${item.providerCount})`
                            : "Connected"}
                      </span>
                    </div>
                    <ChevronRight className="size-3.5 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
                  </>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>

      <SecretDialog
        open={!!editingSecret}
        onOpenChange={(open) => {
          if (!open) setEditingSecret(null);
        }}
        onSaved={fetchItems}
        secret={editingSecret ?? undefined}
        secretActions={secretActions}
      />
    </>
  );
};
