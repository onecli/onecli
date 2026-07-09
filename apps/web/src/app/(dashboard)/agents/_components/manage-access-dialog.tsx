"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
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
import {
  useAgentSecrets,
  useAgentConnections,
  useUpdateSecretMode,
  useUpdateAgentSecrets,
  useUpdateAgentConnections,
} from "@/hooks/use-agents";
import { useSecrets } from "@/hooks/use-secrets";
import { useConnections } from "@/hooks/use-connections";
import type { Secret, Connection } from "@/lib/api";
import { getApp } from "@onecli/api/apps/registry";
import { extractLabel } from "@onecli/api/services/connection-service";
import type { SecretMode } from "@onecli/api/services/agent-service";
import { granularAccessConfigs } from "@/lib/granular-access";
import { ProAppDialog } from "@/lib/components/pro-app-dialog";

interface ManageAccessDialogProps {
  agent: {
    id: string;
    name: string;
    secretMode: SecretMode;
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated?: () => void;
}

export const ManageAccessDialog = ({
  agent,
  open,
  onOpenChange,
  onUpdated,
}: ManageAccessDialogProps) => {
  // Reads via React Query. The shared secret/connection lists are cached and
  // deduped; the agent's current assignments are gated on `open` so they don't
  // fetch while the dialog is closed.
  const { data: secretsList = [], isPending: secretsLoading } = useSecrets();
  const { data: connectionsList = [], isPending: connectionsLoading } =
    useConnections();
  const { data: assignedSecretIds, isPending: assignedSecretsLoading } =
    useAgentSecrets(agent.id, open);
  const { data: assignedConnections, isPending: assignedConnectionsLoading } =
    useAgentConnections(agent.id, open);

  const updateSecretMode = useUpdateSecretMode();
  const updateAgentSecrets = useUpdateAgentSecrets();
  const updateAgentConnections = useUpdateAgentConnections();

  // User-editable buffers, seeded from the agent's assignments on open.
  const [mode, setMode] = useState<SecretMode>(
    agent.secretMode === "selective" ? "selective" : "all",
  );
  const [selectedSecretIds, setSelectedSecretIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [connectionPolicies, setConnectionPolicies] = useState<
    Map<string, Record<string, unknown> | null>
  >(() => new Map());
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  const [granularDialogConnId, setGranularDialogConnId] = useState<
    string | null
  >(null);
  const [editingPolicy, setEditingPolicy] = useState<Record<
    string,
    unknown
  > | null>(null);

  const loading =
    secretsLoading ||
    connectionsLoading ||
    assignedSecretsLoading ||
    assignedConnectionsLoading;

  // Split the shared lists into project/org buckets (connections must be live).
  const { secrets, orgSecrets } = useMemo(() => {
    const project: Secret[] = [];
    const org: Secret[] = [];
    for (const s of secretsList) {
      (s.scope === "organization" ? org : project).push(s);
    }
    return { secrets: project, orgSecrets: org };
  }, [secretsList]);

  const { appConnections, orgConnections } = useMemo(() => {
    const project: Connection[] = [];
    const org: Connection[] = [];
    for (const c of connectionsList) {
      if (c.status !== "connected") continue;
      (c.scope === "organization" ? org : project).push(c);
    }
    return { appConnections: project, orgConnections: org };
  }, [connectionsList]);

  // Reset transient UI + mode whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setMode(agent.secretMode === "selective" ? "selective" : "all");
    setSearch("");
    setGranularDialogConnId(null);
  }, [open, agent.secretMode]);

  // Seed the edit buffers once per open, once the agent's assignments load —
  // guarded so a background refetch can't clobber in-progress edits.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!open) {
      seededRef.current = false;
      return;
    }
    if (seededRef.current || !assignedSecretIds || !assignedConnections) return;
    setSelectedSecretIds(new Set(assignedSecretIds));
    setConnectionPolicies(
      new Map(
        assignedConnections.map((c) => [c.appConnectionId, c.sessionPolicy]),
      ),
    );
    seededRef.current = true;
  }, [open, assignedSecretIds, assignedConnections]);

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
    (list: Connection[]) => {
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
  const filteredConnections = useMemo(
    () => filterConnections(appConnections),
    [appConnections, filterConnections],
  );
  const filteredOrgConnections = useMemo(
    () => filterConnections(orgConnections),
    [orgConnections, filterConnections],
  );

  const allConnections = useMemo(
    () => [...appConnections, ...orgConnections],
    [appConnections, orgConnections],
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

  const toggleConnection = (connectionId: string) => {
    setConnectionPolicies((prev) => {
      const next = new Map(prev);
      if (next.has(connectionId)) next.delete(connectionId);
      else next.set(connectionId, null);
      return next;
    });
  };

  const totalItems =
    secrets.length +
    orgSecrets.length +
    appConnections.length +
    orgConnections.length;
  const totalSelected = selectedSecretIds.size + connectionPolicies.size;

  const selectAll = () => {
    setSelectedSecretIds(new Set([...secrets, ...orgSecrets].map((s) => s.id)));
    const allPolicies = new Map<string, Record<string, unknown> | null>();
    for (const c of [...appConnections, ...orgConnections]) {
      allPolicies.set(c.id, connectionPolicies.get(c.id) ?? null);
    }
    setConnectionPolicies(allPolicies);
  };

  const clearAll = () => {
    setSelectedSecretIds(new Set());
    setConnectionPolicies(new Map());
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateSecretMode.mutateAsync({ agentId: agent.id, mode });
      if (mode === "selective") {
        const connPayload = Array.from(connectionPolicies.entries()).map(
          ([id, policy]) => ({
            appConnectionId: id,
            sessionPolicy: policy,
          }),
        );
        await Promise.all([
          updateAgentSecrets.mutateAsync({
            agentId: agent.id,
            secretIds: Array.from(selectedSecretIds),
          }),
          updateAgentConnections.mutateAsync({
            agentId: agent.id,
            connections: connPayload,
          }),
        ]);
      }
      onUpdated?.();
      onOpenChange(false);
      toast.success("Credential access updated");
    } catch {
      toast.error("Failed to update credential access");
    } finally {
      setSaving(false);
    }
  };

  const isSelective = mode === "selective";
  const hasItems = totalItems > 0;

  const granularDialogConn = useMemo(
    () =>
      granularDialogConnId
        ? [...appConnections, ...orgConnections].find(
            (c) => c.id === granularDialogConnId,
          )
        : undefined,
    [granularDialogConnId, appConnections, orgConnections],
  );
  const granularDialogConfig = granularDialogConn
    ? granularAccessConfigs.get(granularDialogConn.provider)
    : undefined;
  const granularDialogApp = granularDialogConn
    ? getApp(granularDialogConn.provider)
    : undefined;
  const granularDialogMeta =
    (granularDialogConn?.metadata as Record<string, unknown>) ?? {};

  const openGranularDialog = (connId: string) => {
    setGranularDialogConnId(connId);
    setEditingPolicy(connectionPolicies.get(connId) ?? null);
  };

  const saveGranularPolicy = () => {
    if (granularDialogConnId) {
      setConnectionPolicies((prev) => {
        const next = new Map(prev);
        next.set(granularDialogConnId, editingPolicy);
        return next;
      });
    }
    setGranularDialogConnId(null);
  };

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

  const renderConnectionSection = (title: string, items: Connection[]) => {
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
          const isSelected = connectionPolicies.has(conn.id);
          const config = granularAccessConfigs.get(conn.provider);
          const hasGranularAccess =
            config && isSelected && config.isSupported(meta ?? {});
          const policy = connectionPolicies.get(conn.id);

          const policyItems = hasGranularAccess
            ? config.getItems(meta ?? {})
            : [];
          const selectedItemIds = new Set(
            policy && hasGranularAccess ? config.getSelectedItems(policy) : [],
          );
          const isAllItems = !policy || Object.keys(policy).length === 0;

          return (
            <div key={conn.id}>
              <label className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors">
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={() => toggleConnection(conn.id)}
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
                    <p className="truncate text-sm font-medium">
                      {displayName}
                    </p>
                    {!hasMultiple && label && (
                      <p className="text-muted-foreground truncate text-xs">
                        {label}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {hasGranularAccess &&
                    config.PolicyDialogContent &&
                    !isAllItems && (
                      <Badge variant="outline" className="text-xs">
                        {selectedItemIds.size}{" "}
                        {selectedItemIds.size !== 1
                          ? config.itemLabel.plural
                          : config.itemLabel.singular}
                      </Badge>
                    )}
                  <Badge variant="secondary" className="text-xs">
                    {app?.name ?? conn.provider}
                  </Badge>
                </div>
              </label>

              {hasGranularAccess && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    openGranularDialog(conn.id);
                  }}
                  className="hover:bg-muted/50 ml-9 mr-3 mb-2 flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors"
                >
                  <config.Icon className="text-muted-foreground size-3" />
                  <span className="text-muted-foreground text-xs">
                    {config.formatSummary
                      ? config.formatSummary(policy ?? null, meta ?? {})
                      : isAllItems
                        ? `All ${config.itemLabel.plural}`
                        : `${selectedItemIds.size} of ${policyItems.length} ${config.itemLabel.plural}`}
                  </span>
                  <span className="text-muted-foreground/30 text-xs">·</span>
                  <span className="text-muted-foreground text-xs font-medium">
                    Manage
                  </span>
                  {!config.PolicyDialogContent && (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/20 bg-brand/5 px-2 py-px">
                      <svg
                        width="11"
                        height="9"
                        viewBox="0 0 44 36"
                        fill="none"
                        className="-mt-px shrink-0"
                      >
                        <path
                          d="M2 2L16 18L2 34"
                          stroke="currentColor"
                          strokeWidth="5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="text-brand"
                        />
                        <path
                          d="M22 2L36 18L22 34"
                          stroke="currentColor"
                          strokeWidth="5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="text-brand"
                        />
                      </svg>
                      <span className="text-[10px] font-semibold tracking-wide text-brand">
                        Team
                      </span>
                    </span>
                  )}
                </button>
              )}
            </div>
          );
        })}
      </>
    );
  };

  return (
    <>
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
                      <span className="text-muted-foreground/40 text-xs">
                        /
                      </span>
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
                  <ScrollArea className="h-70 overflow-hidden rounded-md border">
                    <div className="divide-border divide-y">
                      {renderSecretSection("Secrets", filteredSecrets)}
                      {renderConnectionSection(
                        "App connections",
                        filteredConnections,
                      )}
                      {renderSecretSection(
                        "Organization secrets",
                        filteredOrgSecrets,
                      )}
                      {renderConnectionSection(
                        "Organization app connections",
                        filteredOrgConnections,
                      )}

                      {filteredSecrets.length === 0 &&
                        filteredOrgSecrets.length === 0 &&
                        filteredConnections.length === 0 &&
                        filteredOrgConnections.length === 0 && (
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

      {/* Granular access policy dialog (EE) */}
      {granularDialogConnId && granularDialogConfig?.PolicyDialogContent && (
        <Dialog open onOpenChange={() => setGranularDialogConnId(null)}>
          <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-sm">
            <DialogHeader className="border-border/50 border-b px-5 py-4">
              <div className="flex items-center gap-3">
                {granularDialogApp?.icon && (
                  <AppIcon
                    icon={granularDialogApp.icon}
                    darkIcon={granularDialogApp.darkIcon}
                    name={granularDialogApp.name}
                    size={18}
                  />
                )}
                <div>
                  <DialogTitle className="text-sm">
                    Manage {granularDialogConfig.itemLabel.singular} access
                  </DialogTitle>
                  <p className="text-muted-foreground text-xs">
                    {granularDialogConn?.label ??
                      extractLabel(granularDialogMeta ?? undefined) ??
                      granularDialogApp?.name}
                  </p>
                </div>
              </div>
            </DialogHeader>

            <granularDialogConfig.PolicyDialogContent
              connectionId={granularDialogConnId}
              metadata={granularDialogMeta}
              policy={editingPolicy}
              onPolicyChange={setEditingPolicy}
              onSave={saveGranularPolicy}
              onCancel={() => setGranularDialogConnId(null)}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* Granular access upsell (OSS) */}
      {granularDialogConnId && !granularDialogConfig?.PolicyDialogContent && (
        <ProAppDialog
          appName="Granular access control"
          appIcon={granularDialogApp?.icon ?? ""}
          appDarkIcon={granularDialogApp?.darkIcon}
          description="Control which resources each agent can access through your app connections."
          open
          onOpenChange={() => setGranularDialogConnId(null)}
        />
      )}
    </>
  );
};
