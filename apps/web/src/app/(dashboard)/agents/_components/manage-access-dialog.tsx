"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useInvalidateGatewayCache } from "@/hooks/use-invalidate-cache";
import { AppIcon } from "@/app/(dashboard)/connections/_components/app-icon";
import {
  KeyRound,
  Loader2,
  Search,
  Globe,
  ListChecks,
  Plug,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Badge } from "@onecli/ui/components/badge";
import { Checkbox } from "@onecli/ui/components/checkbox";
import { ScrollArea } from "@onecli/ui/components/scroll-area";
import { cn } from "@onecli/ui/lib/utils";
import { getSecrets } from "@/lib/actions/secrets";
import { getAppConnections } from "@/lib/actions/connections";
import {
  getAgentSecrets,
  updateAgentSecretMode,
  updateAgentSecrets,
  getAgentAppConnections,
  updateAgentAppConnections,
} from "@/lib/actions/agents";
import { getApp } from "@onecli/api/apps/registry";
import { extractLabel } from "@onecli/api/services/connection-service";
import type { SecretMode } from "@onecli/api/services/agent-service";

interface ManageAccessDialogProps {
  agent: {
    id: string;
    name: string;
    secretMode: SecretMode;
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
}

type Secret = Awaited<ReturnType<typeof getSecrets>>[number];
type AppConnection = Awaited<ReturnType<typeof getAppConnections>>[number];

export const ManageAccessDialog = ({
  agent,
  open,
  onOpenChange,
  onUpdated,
}: ManageAccessDialogProps) => {
  const invalidateCache = useInvalidateGatewayCache();
  const [mode, setMode] = useState<SecretMode>(
    agent.secretMode === "selective" ? "selective" : "all",
  );
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [orgSecrets, setOrgSecrets] = useState<Secret[]>([]);
  const [appConnections, setAppConnections] = useState<AppConnection[]>([]);
  const [orgAppConnections, setOrgAppConnections] = useState<AppConnection[]>(
    [],
  );
  const [selectedSecretIds, setSelectedSecretIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedAppConnectionIds, setSelectedAppConnectionIds] = useState<
    Set<string>
  >(() => new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [allSecrets, assignedSecretIds, allConnections, assignedAppIds] =
        await Promise.all([
          getSecrets(),
          getAgentSecrets(agent.id),
          getAppConnections(),
          getAgentAppConnections(agent.id),
        ]);
      const projectSecrets: typeof allSecrets = [];
      const orgSecretsList: typeof allSecrets = [];
      for (const s of allSecrets) {
        (s.scope === "organization" ? orgSecretsList : projectSecrets).push(s);
      }
      setSecrets(projectSecrets);
      setOrgSecrets(orgSecretsList);
      setSelectedSecretIds(new Set(assignedSecretIds));
      const projectConns: typeof allConnections = [];
      const orgConns: typeof allConnections = [];
      for (const c of allConnections) {
        if (c.status !== "connected") continue;
        (c.scope === "organization" ? orgConns : projectConns).push(c);
      }
      setAppConnections(projectConns);
      setOrgAppConnections(orgConns);
      setSelectedAppConnectionIds(new Set(assignedAppIds));
    } catch {
      toast.error("Failed to load credentials");
    } finally {
      setLoading(false);
    }
  }, [agent.id]);

  useEffect(() => {
    if (open) {
      setMode(agent.secretMode === "selective" ? "selective" : "all");
      setSearch("");
      fetchData();
    }
  }, [open, agent.secretMode, fetchData]);

  const filterSecrets = useCallback(
    (list: Secret[]) => {
      if (!search.trim()) return list;
      const q = search.toLowerCase();
      return list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.hostPattern.toLowerCase().includes(q),
      );
    },
    [search],
  );

  const filterConnections = useCallback(
    (list: AppConnection[]) => {
      if (!search.trim()) return list;
      const q = search.toLowerCase();
      return list.filter((c) => {
        const app = getApp(c.provider);
        const name = app?.name ?? c.provider;
        const meta = c.metadata as {
          username?: string;
          email?: string;
          name?: string;
        } | null;
        return (
          name.toLowerCase().includes(q) ||
          c.provider.toLowerCase().includes(q) ||
          (c.label?.toLowerCase().includes(q) ?? false) ||
          (meta?.email?.toLowerCase().includes(q) ?? false) ||
          (meta?.username?.toLowerCase().includes(q) ?? false) ||
          (meta?.name?.toLowerCase().includes(q) ?? false)
        );
      });
    },
    [search],
  );

  const filteredSecrets = useMemo(
    () => filterSecrets(secrets),
    [secrets, filterSecrets],
  );
  const filteredOrgSecrets = useMemo(
    () => filterSecrets(orgSecrets),
    [orgSecrets, filterSecrets],
  );
  const filteredAppConnections = useMemo(
    () => filterConnections(appConnections),
    [appConnections, filterConnections],
  );
  const filteredOrgAppConnections = useMemo(
    () => filterConnections(orgAppConnections),
    [orgAppConnections, filterConnections],
  );

  const allConnections = useMemo(
    () => [...appConnections, ...orgAppConnections],
    [appConnections, orgAppConnections],
  );
  const providerCounts = useMemo(() => {
    const counts = new Map<string, number>();
    allConnections.forEach((c) =>
      counts.set(c.provider, (counts.get(c.provider) ?? 0) + 1),
    );
    return counts;
  }, [allConnections]);

  const toggleSecret = (secretId: string) => {
    setSelectedSecretIds((prev) => {
      const next = new Set(prev);
      if (next.has(secretId)) next.delete(secretId);
      else next.add(secretId);
      return next;
    });
  };

  const toggleAppConnection = (connectionId: string) => {
    setSelectedAppConnectionIds((prev) => {
      const next = new Set(prev);
      if (next.has(connectionId)) next.delete(connectionId);
      else next.add(connectionId);
      return next;
    });
  };

  const totalItems =
    secrets.length +
    orgSecrets.length +
    appConnections.length +
    orgAppConnections.length;
  const totalSelected = selectedSecretIds.size + selectedAppConnectionIds.size;

  const selectAll = () => {
    setSelectedSecretIds(new Set([...secrets, ...orgSecrets].map((s) => s.id)));
    setSelectedAppConnectionIds(
      new Set([...appConnections, ...orgAppConnections].map((c) => c.id)),
    );
  };

  const clearAll = () => {
    setSelectedSecretIds(new Set());
    setSelectedAppConnectionIds(new Set());
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateAgentSecretMode(agent.id, mode);
      if (mode === "selective") {
        await Promise.all([
          updateAgentSecrets(agent.id, Array.from(selectedSecretIds)),
          updateAgentAppConnections(
            agent.id,
            Array.from(selectedAppConnectionIds),
          ),
        ]);
      }
      onUpdated();
      onOpenChange(false);
      invalidateCache();
      toast.success("Credential access updated");
    } catch {
      toast.error("Failed to update credential access");
    } finally {
      setSaving(false);
    }
  };

  const isSelective = mode === "selective";
  const hasItems = totalItems > 0;

  const renderSecretSection = (title: string, items: Secret[]) => {
    if (items.length === 0) return null;
    return (
      <>
        <div className="bg-muted/30 flex items-center gap-2 px-3 py-1.5">
          <KeyRound className="text-muted-foreground size-3" />
          <p className="text-muted-foreground text-xs font-medium">{title}</p>
        </div>
        {items.map((secret) => (
          <label
            key={secret.id}
            className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors"
          >
            <Checkbox
              checked={selectedSecretIds.has(secret.id)}
              onCheckedChange={() => toggleSecret(secret.id)}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{secret.name}</p>
              <code className="text-muted-foreground text-xs">
                {secret.hostPattern}
              </code>
            </div>
            <Badge variant="secondary" className="shrink-0 text-xs">
              {secret.typeLabel}
            </Badge>
          </label>
        ))}
      </>
    );
  };

  const renderConnectionSection = (title: string, items: AppConnection[]) => {
    if (items.length === 0) return null;
    return (
      <>
        <div className="bg-muted/30 flex items-center gap-2 px-3 py-1.5">
          <Plug className="text-muted-foreground size-3" />
          <p className="text-muted-foreground text-xs font-medium">{title}</p>
        </div>
        {items.map((conn) => {
          const app = getApp(conn.provider);
          const meta = conn.metadata as Record<string, unknown> | null;
          const label = conn.label ?? extractLabel(meta ?? undefined);
          const baseName = app?.name ?? conn.provider;
          const hasMultiple = (providerCounts.get(conn.provider) ?? 0) > 1;
          const displayName =
            hasMultiple && label ? `${baseName} - ${label}` : baseName;
          return (
            <label
              key={conn.id}
              className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors"
            >
              <Checkbox
                checked={selectedAppConnectionIds.has(conn.id)}
                onCheckedChange={() => toggleAppConnection(conn.id)}
              />
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                {app?.icon && (
                  <AppIcon
                    icon={app.icon}
                    darkIcon={app.darkIcon}
                    name={baseName}
                    size={16}
                  />
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{displayName}</p>
                  {!hasMultiple && label && (
                    <p className="text-muted-foreground truncate text-xs">
                      {label}
                    </p>
                  )}
                </div>
              </div>
              <Badge variant="secondary" className="shrink-0 text-xs">
                {app?.name ?? conn.provider}
              </Badge>
            </label>
          );
        })}
      </>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle>Credential access for {agent.name}</DialogTitle>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Secrets and app connections are injected by the gateway at request
            time. The agent never sees raw values.
          </p>
        </DialogHeader>

        {/* Mode selection */}
        <div className="space-y-2 px-6 pb-2">
          <p className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
            Access mode
          </p>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                {
                  value: "all",
                  icon: Globe,
                  label: "All credentials",
                  desc: "Every secret and app connection",
                },
                {
                  value: "selective",
                  icon: ListChecks,
                  label: "Selective",
                  desc: "Choose specific secrets and apps",
                },
              ] as const
            ).map(({ value, icon: Icon, label, desc }) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={cn(
                  "flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors",
                  mode === value
                    ? "border-foreground/30 bg-muted/60"
                    : "border-border hover:bg-muted/30",
                )}
              >
                <div className="flex items-center gap-2">
                  <Icon
                    className={cn(
                      "size-3.5",
                      mode === value
                        ? "text-foreground"
                        : "text-muted-foreground/60",
                    )}
                  />
                  <p
                    className={cn(
                      "text-sm font-medium",
                      mode !== value && "text-muted-foreground",
                    )}
                  >
                    {label}
                  </p>
                </div>
                <p className="text-muted-foreground text-xs">{desc}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Credential lists — revealed when selective */}
        {isSelective && (
          <div className="px-6 pt-2 pb-1">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="text-muted-foreground size-4 animate-spin" />
              </div>
            ) : !hasItems ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <div className="bg-muted mb-3 flex size-10 items-center justify-center rounded-full">
                  <KeyRound className="text-muted-foreground size-4" />
                </div>
                <p className="text-sm font-medium">No credentials yet</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Add secrets or connect apps first.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {/* Search */}
                <div className="relative">
                  <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                  <Input
                    placeholder="Filter credentials..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-8 pl-8 text-sm"
                  />
                </div>

                {/* Toolbar: count + actions */}
                <div className="flex items-center justify-between">
                  <p className="text-muted-foreground text-xs">
                    <span className="text-foreground font-medium">
                      {totalSelected}
                    </span>{" "}
                    of {totalItems} selected
                  </p>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={selectAll}
                      className="text-muted-foreground hover:text-foreground text-xs transition-colors"
                    >
                      Select all
                    </button>
                    <span className="text-muted-foreground/40 text-xs">/</span>
                    <button
                      type="button"
                      onClick={clearAll}
                      className="text-muted-foreground hover:text-foreground text-xs transition-colors"
                    >
                      Clear
                    </button>
                  </div>
                </div>

                {/* List */}
                <ScrollArea className="h-[280px] overflow-hidden rounded-md border">
                  <div className="divide-border divide-y">
                    {renderSecretSection("Secrets", filteredSecrets)}
                    {renderConnectionSection(
                      "App connections",
                      filteredAppConnections,
                    )}
                    {renderSecretSection(
                      "Organization secrets",
                      filteredOrgSecrets,
                    )}
                    {renderConnectionSection(
                      "Organization app connections",
                      filteredOrgAppConnections,
                    )}

                    {filteredSecrets.length === 0 &&
                      filteredOrgSecrets.length === 0 &&
                      filteredAppConnections.length === 0 &&
                      filteredOrgAppConnections.length === 0 && (
                        <p className="text-muted-foreground py-6 text-center text-xs">
                          No credentials match &ldquo;{search}&rdquo;
                        </p>
                      )}
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <DialogFooter className="border-border/50 border-t px-6 py-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={loading}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
