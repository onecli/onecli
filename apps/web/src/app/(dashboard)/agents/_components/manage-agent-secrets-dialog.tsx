"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { Checkbox } from "@onecli/ui/components/checkbox";
import { Label } from "@onecli/ui/components/label";
import { useAuth } from "@/providers/auth-provider";
import {
  getAgentSecretAssignments,
  setAgentSecretAssignments,
} from "@/lib/actions/agents";

interface SecretAssignment {
  id: string;
  name: string;
  type: string;
  hostPattern: string;
  pathPattern: string | null;
  assigned: boolean;
}

interface ManageAgentSecretsDialogProps {
  agentId: string;
  agentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export const ManageAgentSecretsDialog = ({
  agentId,
  agentName,
  open,
  onOpenChange,
  onSaved,
}: ManageAgentSecretsDialogProps) => {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [items, setItems] = useState<SecretAssignment[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open || !user?.id) return;

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const result = await getAgentSecretAssignments(agentId, user.id);
        if (cancelled) return;

        setItems(result);
        setSelected(
          result.reduce<Record<string, boolean>>((acc, item) => {
            acc[item.id] = item.assigned;
            return acc;
          }, {}),
        );
      } catch {
        if (!cancelled) {
          toast.error("Failed to load secret assignments");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [open, user?.id, agentId]);

  const selectedIds = useMemo(
    () => Object.keys(selected).filter((id) => selected[id]),
    [selected],
  );
  const selectedCount = selectedIds.length;

  const handleToggle = (secretId: string, checked: boolean) => {
    setSelected((prev) => ({
      ...prev,
      [secretId]: checked,
    }));
  };

  const handleSave = async () => {
    if (!user?.id) return;

    if (selectedCount === 0) {
      toast.error("Assign at least one secret to this agent");
      return;
    }

    setSaving(true);
    try {
      await setAgentSecretAssignments(agentId, selectedIds, user.id);
      toast.success("Secret assignments updated");
      onSaved();
      onOpenChange(false);
    } catch {
      toast.error("Failed to update secret assignments");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Manage secrets</DialogTitle>
          <DialogDescription>
            Choose which secrets can be injected for {agentName}.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-80 space-y-3 overflow-y-auto py-2 pr-1">
          {loading ? (
            <p className="text-muted-foreground text-sm">Loading secrets...</p>
          ) : items.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No secrets found. Create a secret first, then assign it here.
            </p>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className="border-border flex items-start gap-3 rounded-lg border p-3"
              >
                <Checkbox
                  id={`secret-${item.id}`}
                  checked={!!selected[item.id]}
                  onCheckedChange={(checked) =>
                    handleToggle(item.id, checked === true)
                  }
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <Label
                    htmlFor={`secret-${item.id}`}
                    className="cursor-pointer text-sm font-medium"
                  >
                    {item.name}
                  </Label>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {item.type} · {item.hostPattern}
                    {item.pathPattern ? ` · ${item.pathPattern}` : ""}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>

        {!loading && items.length > 0 && (
          <p className="text-muted-foreground text-xs">
            {selectedCount} {selectedCount === 1 ? "secret" : "secrets"} selected. At least one secret is required.
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            loading={saving}
            disabled={loading || selectedCount === 0}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
