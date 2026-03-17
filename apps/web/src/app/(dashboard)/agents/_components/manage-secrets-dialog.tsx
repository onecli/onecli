"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { KeyRound, Loader2, Search, Globe, ListChecks } from "lucide-react";
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
import {
  getAgentSecrets,
  updateAgentSecretMode,
  updateAgentSecrets,
} from "@/lib/actions/agents";
import type { SecretMode } from "@/lib/services/agent-service";

interface ManageSecretsDialogProps {
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

export const ManageSecretsDialog = ({
  agent,
  open,
  onOpenChange,
  onUpdated,
}: ManageSecretsDialogProps) => {
  const [mode, setMode] = useState<SecretMode>(
    agent.secretMode === "selective" ? "selective" : "all",
  );
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [allSecrets, assignedIds] = await Promise.all([
        getSecrets(),
        getAgentSecrets(agent.id),
      ]);
      setSecrets(allSecrets);
      setSelectedIds(new Set(assignedIds));
    } catch {
      toast.error("Failed to load secrets");
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

  const filteredSecrets = useMemo(() => {
    if (!search.trim()) return secrets;
    const q = search.toLowerCase();
    return secrets.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.hostPattern.toLowerCase().includes(q),
    );
  }, [secrets, search]);

  const toggleSecret = (secretId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(secretId)) {
        next.delete(secretId);
      } else {
        next.add(secretId);
      }
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateAgentSecretMode(agent.id, mode);
      if (mode === "selective") {
        await updateAgentSecrets(agent.id, Array.from(selectedIds));
      }
      onUpdated();
      onOpenChange(false);
      toast.success("Secret permissions updated");
    } catch {
      toast.error("Failed to update secret permissions");
    } finally {
      setSaving(false);
    }
  };

  const isSelective = mode === "selective";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle>Secret access for {agent.name}</DialogTitle>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Secrets are injected by the gateway at request time. The agent never
            sees raw values.
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
                  label: "All secrets",
                  desc: "Every secret in your account",
                },
                {
                  value: "selective",
                  icon: ListChecks,
                  label: "Selective",
                  desc: "Choose specific secrets",
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

        {/* Secret list — revealed when selective */}
        {isSelective && (
          <div className="px-6 pt-2 pb-1">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="text-muted-foreground size-4 animate-spin" />
              </div>
            ) : secrets.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <div className="bg-muted mb-3 flex size-10 items-center justify-center rounded-full">
                  <KeyRound className="text-muted-foreground size-4" />
                </div>
                <p className="text-sm font-medium">No secrets yet</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Add secrets in the Secrets page first.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {/* Search */}
                <div className="relative">
                  <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                  <Input
                    placeholder="Filter secrets..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-8 pl-8 text-sm"
                  />
                </div>

                {/* Toolbar: count + actions */}
                <div className="flex items-center justify-between">
                  <p className="text-muted-foreground text-xs">
                    <span className="text-foreground font-medium">
                      {selectedIds.size}
                    </span>{" "}
                    of {secrets.length} selected
                  </p>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedIds(new Set(secrets.map((s) => s.id)))
                      }
                      className="text-muted-foreground hover:text-foreground text-xs transition-colors"
                    >
                      Select all
                    </button>
                    <span className="text-muted-foreground/40 text-xs">/</span>
                    <button
                      type="button"
                      onClick={() => setSelectedIds(new Set())}
                      className="text-muted-foreground hover:text-foreground text-xs transition-colors"
                    >
                      Clear
                    </button>
                  </div>
                </div>

                {/* List */}
                <ScrollArea className="h-[200px] overflow-hidden rounded-md border">
                  <div className="divide-border divide-y">
                    {filteredSecrets.map((secret) => (
                      <label
                        key={secret.id}
                        className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors"
                      >
                        <Checkbox
                          checked={selectedIds.has(secret.id)}
                          onCheckedChange={() => toggleSecret(secret.id)}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {secret.name}
                          </p>
                          <code className="text-muted-foreground text-xs">
                            {secret.hostPattern}
                          </code>
                        </div>
                        <Badge variant="secondary" className="shrink-0 text-xs">
                          {secret.typeLabel}
                        </Badge>
                      </label>
                    ))}
                    {filteredSecrets.length === 0 && (
                      <p className="text-muted-foreground py-6 text-center text-xs">
                        No secrets match &ldquo;{search}&rdquo;
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
