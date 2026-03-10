"use client";

import { useEffect, useState } from "react";
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
import { Label } from "@onecli/ui/components/label";
import { useAuth } from "@/providers/auth-provider";
import { updatePolicy, getAgentsAndSecrets } from "@/lib/actions/policies";

interface AgentOption {
  id: string;
  name: string;
}

interface SecretOption {
  id: string;
  name: string;
  type: string;
  hostPattern: string;
}

interface EditPolicyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  policy: {
    id: string;
    agent: { id: string; name: string };
    secret: { id: string; name: string; type: string; hostPattern: string };
  };
  onUpdated: () => void;
}

export const EditPolicyDialog = ({
  open,
  onOpenChange,
  policy,
  onUpdated,
}: EditPolicyDialogProps) => {
  const { user } = useAuth();
  const [saving, setSaving] = useState(false);
  const [loadingOptions, setLoadingOptions] = useState(false);

  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [secrets, setSecrets] = useState<SecretOption[]>([]);
  const [agentId, setAgentId] = useState(policy.agent.id);
  const [secretId, setSecretId] = useState(policy.secret.id);

  useEffect(() => {
    if (!open || !user?.id) return;
    setLoadingOptions(true);
    setAgentId(policy.agent.id);
    setSecretId(policy.secret.id);
    getAgentsAndSecrets(user.id)
      .then(({ agents, secrets }) => {
        setAgents(agents);
        setSecrets(secrets);
      })
      .finally(() => setLoadingOptions(false));
  }, [open, user?.id, policy.agent.id, policy.secret.id]);

  const hasChanges =
    agentId !== policy.agent.id || secretId !== policy.secret.id;

  const handleSave = async () => {
    if (!user?.id || !hasChanges) return;
    setSaving(true);
    try {
      const data: { agentId?: string; secretId?: string } = {};
      if (agentId !== policy.agent.id) data.agentId = agentId;
      if (secretId !== policy.secret.id) data.secretId = secretId;

      await updatePolicy(policy.id, data, user.id);
      onUpdated();
      toast.success("Policy updated");
      onOpenChange(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update policy";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const selectClasses =
    "border-input bg-transparent dark:bg-input/30 h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:opacity-50";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit policy</DialogTitle>
          <DialogDescription>
            Change which agent or secret this policy connects.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="edit-policy-agent">Agent</Label>
            <select
              id="edit-policy-agent"
              className={selectClasses}
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              disabled={loadingOptions}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-policy-secret">Secret</Label>
            <select
              id="edit-policy-secret"
              className={selectClasses}
              value={secretId}
              onChange={(e) => setSecretId(e.target.value)}
              disabled={loadingOptions}
            >
              {secrets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.hostPattern})
                </option>
              ))}
            </select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!hasChanges || saving}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
