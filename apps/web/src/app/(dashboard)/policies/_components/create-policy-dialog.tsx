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
import { createPolicy, getAgentsAndSecrets } from "@/lib/actions/policies";

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

interface CreatePolicyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

export const CreatePolicyDialog = ({
  open,
  onOpenChange,
  onCreated,
}: CreatePolicyDialogProps) => {
  const { user } = useAuth();
  const [creating, setCreating] = useState(false);
  const [loadingOptions, setLoadingOptions] = useState(false);

  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [secrets, setSecrets] = useState<SecretOption[]>([]);
  const [agentId, setAgentId] = useState("");
  const [secretId, setSecretId] = useState("");

  useEffect(() => {
    if (!open || !user?.id) return;
    setLoadingOptions(true);
    getAgentsAndSecrets(user.id)
      .then(({ agents, secrets }) => {
        setAgents(agents);
        setSecrets(secrets);
      })
      .finally(() => setLoadingOptions(false));
  }, [open, user?.id]);

  const handleCreate = async () => {
    if (!user?.id || !agentId || !secretId) return;
    setCreating(true);
    try {
      await createPolicy(agentId, secretId, user.id);
      onCreated();
      toast.success("Policy created");
      handleClose(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create policy";
      toast.error(message);
    } finally {
      setCreating(false);
    }
  };

  const handleClose = (value: boolean) => {
    if (!value) {
      setAgentId("");
      setSecretId("");
    }
    onOpenChange(value);
  };

  const selectClasses =
    "border-input bg-transparent dark:bg-input/30 h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:opacity-50";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add policy</DialogTitle>
          <DialogDescription>
            Grant an agent access to a secret. The proxy will inject the
            credential when the agent&apos;s requests match the secret&apos;s
            host pattern.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="policy-agent">Agent</Label>
            <select
              id="policy-agent"
              className={selectClasses}
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              disabled={loadingOptions}
            >
              <option value="">
                {loadingOptions ? "Loading..." : "Select an agent"}
              </option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            {!loadingOptions && agents.length === 0 && (
              <p className="text-muted-foreground text-xs">
                No agents yet. Create one on the Agents page first.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="policy-secret">Secret</Label>
            <select
              id="policy-secret"
              className={selectClasses}
              value={secretId}
              onChange={(e) => setSecretId(e.target.value)}
              disabled={loadingOptions}
            >
              <option value="">
                {loadingOptions ? "Loading..." : "Select a secret"}
              </option>
              {secrets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.hostPattern})
                </option>
              ))}
            </select>
            {!loadingOptions && secrets.length === 0 && (
              <p className="text-muted-foreground text-xs">
                No secrets yet. Add one on the Secrets page first.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleClose(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!agentId || !secretId || creating}
          >
            {creating ? "Creating..." : "Add Policy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
