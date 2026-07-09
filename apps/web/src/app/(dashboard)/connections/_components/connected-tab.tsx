"use client";

import { useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { connectionsPath } from "@/lib/navigation";
import { ChevronRight, KeyRound } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Card } from "@onecli/ui/components/card";
import { cn } from "@onecli/ui/lib/utils";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { apiGet, type PageScope } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { useConnections, useVaultConnections } from "@/hooks/use-connections";
import { getApp } from "@onecli/api/apps/registry";
import { useAppMessages } from "@/hooks/use-app-connected";
import { extractLabel } from "@onecli/api/services/connection-service";
import { AppIcon } from "./app-icon";
import { SecretDialog } from "./secret-dialog";
import type { SecretActions } from "./types";
import { labelForScope, type ScopeLabelMap } from "./scope-label";

const defaultGetSecrets_ = () => apiGet<SecretItem[]>("/v1/secrets");

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
  scope?: string | null;
  secretData?: {
    id: string;
    name: string;
    type: string;
    typeLabel: string;
    hostPattern: string;
    pathPattern: string | null;
    injectionConfig: unknown;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
  };
}

interface SecretItem {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  hostPattern: string;
  pathPattern: string | null;
  injectionConfig: unknown;
  metadata: Record<string, unknown> | null;
  scope: string | null;
  createdAt: Date;
}

interface ConnectedTabProps {
  getSecrets?: () => Promise<SecretItem[]>;
  basePath?: string;
  secretActions?: SecretActions;
  pageScope?: PageScope;
  scopeLabels?: ScopeLabelMap;
}

export const ConnectedTab = ({
  getSecrets = defaultGetSecrets_,
  basePath,
  secretActions,
  pageScope = "project",
  scopeLabels,
}: ConnectedTabProps) => {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const [editingSecret, setEditingSecret] = useState<
    ConnectedItem["secretData"] | null
  >(null);

  const connectionsQuery = useConnections(pageScope);
  // The extra "connected" key segment keeps this apart from the tab bar's
  // secrets query, whose injected fetcher may differ (partner-merged list).
  const secretsQuery = useQuery({
    queryKey: [...queryKeys.secrets.list(), pageScope, "connected"],
    queryFn: getSecrets,
  });
  const vaultsQuery = useVaultConnections(pageScope === "project");

  const loading =
    connectionsQuery.isPending ||
    secretsQuery.isPending ||
    (pageScope === "project" && vaultsQuery.isPending);

  const items = useMemo(() => {
    const connections = connectionsQuery.data ?? [];
    const secrets = secretsQuery.data ?? [];
    const vaults = pageScope === "project" ? (vaultsQuery.data ?? []) : [];

    const connectedApps = connections.filter((c) => c.status === "connected");
    const providerCounts = new Map<string, number>();
    connectedApps.forEach((c) =>
      providerCounts.set(c.provider, (providerCounts.get(c.provider) ?? 0) + 1),
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
        scope: c.scope,
        typeLabel: isInherited
          ? labelForScope(c.scope, scopeLabels)
          : appDef?.connectionMethod.type === "oauth"
            ? "OAuth"
            : appDef?.connectionMethod.type === "credentials_import"
              ? "Credentials"
              : "API Key",
        detail: label
          ? `Connected as ${label}`
          : `${c.scopes.length} scope${c.scopes.length !== 1 ? "s" : ""} granted`,
        href: connectionsPath({ pathname, basePath }, `/apps/${c.provider}`),
        providerCount: hasMultiple ? providerCounts.get(c.provider) : undefined,
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
        scope: s.scope,
        typeLabel: isInherited
          ? labelForScope(s.scope, scopeLabels)
          : s.typeLabel,
        detail: `Host: ${s.hostPattern}`,
        inherited: isInherited,
        secretData: isInherited ? undefined : s,
      };
    });

    const vaultItems: ConnectedItem[] = vaults.map((v) => ({
      id: `vault-${v.provider}`,
      name: v.name ?? v.provider.charAt(0).toUpperCase() + v.provider.slice(1),
      icon: `/icons/${v.provider}.svg`,
      type: "vault" as const,
      typeLabel: "External Vault",
      detail: v.status === "connected" ? "Connected" : "Paired",
      href: connectionsPath({ pathname, basePath }, `/vaults/${v.provider}`),
    }));

    return [...appItems, ...secretItems, ...vaultItems];
  }, [
    connectionsQuery.data,
    secretsQuery.data,
    vaultsQuery.data,
    pathname,
    basePath,
    pageScope,
    scopeLabels,
  ]);

  const refreshItems = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.connections.all() });
    queryClient.invalidateQueries({ queryKey: queryKeys.secrets.all() });
  };

  useAppMessages({
    onConnected: refreshItems,
    onConfigure: (provider) =>
      router.push(connectionsPath({ pathname, basePath }, `/apps/${provider}`)),
  });

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
            onClick={() => router.push(connectionsPath({ pathname, basePath }))}
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
                    {labelForScope(item.scope, scopeLabels)}
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
        onSaved={refreshItems}
        secret={editingSecret ?? undefined}
        secretActions={secretActions}
      />
    </>
  );
};
