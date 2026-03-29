"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, KeyRound, Loader2 } from "lucide-react";
import { Card } from "@onecli/ui/components/card";
import {
  getAppConnections,
  getVaultConnections,
} from "@/lib/actions/connections";
import { getSecrets } from "@/lib/actions/secrets";
import { getApp } from "@/lib/apps/registry";
import { useAppConnected } from "@/hooks/use-app-connected";
import { AppIcon } from "./app-icon";
import { SecretDialog } from "./secret-dialog";

interface ConnectedItem {
  id: string;
  name: string;
  icon: string | null;
  darkIcon?: string;
  type: "app" | "secret" | "vault";
  typeLabel: string;
  detail: string;
  href?: string;
  secretData?: {
    id: string;
    name: string;
    type: string;
    typeLabel: string;
    hostPattern: string;
    pathPattern: string | null;
    injectionConfig: unknown;
    createdAt: Date;
  };
}

export const ConnectedTab = () => {
  const router = useRouter();
  const [items, setItems] = useState<ConnectedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingSecret, setEditingSecret] = useState<
    ConnectedItem["secretData"] | null
  >(null);

  const fetchItems = useCallback(async () => {
    try {
      const [connections, secrets, vaults] = await Promise.all([
        getAppConnections(),
        getSecrets(),
        getVaultConnections(),
      ]);

      const appItems: ConnectedItem[] = connections
        .filter((c) => c.status === "connected")
        .map((c) => {
          const appDef = getApp(c.provider);
          const metadata = c.metadata as Record<string, unknown> | null;
          return {
            id: `app-${c.provider}`,
            name: appDef?.name ?? c.provider,
            icon: appDef?.icon ?? null,
            darkIcon: appDef?.darkIcon,
            type: "app" as const,
            typeLabel:
              appDef?.connectionMethod.type === "oauth" ? "OAuth" : "API Key",
            detail: metadata?.username
              ? `Connected as ${metadata.username}`
              : `${c.scopes.length} scope${c.scopes.length !== 1 ? "s" : ""} granted`,
            href: `/connections/apps/${c.provider}`,
          };
        });

      const secretItems: ConnectedItem[] = secrets.map((s) => ({
        id: `secret-${s.id}`,
        name: s.name,
        icon: null,
        type: "secret" as const,
        typeLabel: s.typeLabel,
        detail: `Host: ${s.hostPattern}`,
        secretData: s,
      }));

      const vaultItems: ConnectedItem[] = vaults.map((v) => ({
        id: `vault-${v.provider}`,
        name:
          v.name ?? v.provider.charAt(0).toUpperCase() + v.provider.slice(1),
        icon: `/icons/${v.provider}.svg`,
        type: "vault" as const,
        typeLabel: "External Vault",
        detail: v.status === "connected" ? "Connected" : "Paired",
        href: `/connections/vaults/${v.provider}`,
      }));

      setItems([...appItems, ...secretItems, ...vaultItems]);
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  useAppConnected(fetchItems);

  const handleItemClick = (item: ConnectedItem) => {
    if (item.secretData) {
      setEditingSecret(item.secretData);
    } else if (item.href) {
      router.push(item.href);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-sm text-muted-foreground">
          No connected services yet. Head to the{" "}
          <button
            onClick={() => router.push("/connections")}
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
            className="group p-4 cursor-pointer transition-colors hover:bg-accent/50"
            onClick={() => handleItemClick(item)}
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
                <div className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-brand" />
                  <span className="text-xs text-brand font-medium">
                    {item.type === "secret" ? "Active" : "Connected"}
                  </span>
                </div>
                <ChevronRight className="size-3.5 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
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
      />
    </>
  );
};
