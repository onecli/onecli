"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
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
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { useAuth } from "@/providers/auth-provider";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { createAgent } from "@/lib/actions/agents";

interface CreateAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

export const CreateAgentDialog = ({
  open,
  onOpenChange,
  onCreated,
}: CreateAgentDialogProps) => {
  const { user } = useAuth();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const { copied, copy } = useCopyToClipboard();

  const handleCreate = async () => {
    if (!user?.id || !name.trim()) return;
    setCreating(true);
    try {
      const agent = await createAgent(name, user.id);
      setNewToken(agent.accessToken);
      onCreated();
      toast.success("Agent created");
    } catch {
      toast.error("Failed to create agent");
    } finally {
      setCreating(false);
    }
  };

  const handleClose = (value: boolean) => {
    if (!value) {
      setName("");
      setNewToken(null);
    }
    onOpenChange(value);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        {newToken ? (
          <>
            <DialogHeader>
              <DialogTitle>Agent created</DialogTitle>
              <DialogDescription>
                Copy the access token now. You won&apos;t be able to see it
                again.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="flex items-center gap-2">
                <code className="bg-muted flex-1 truncate rounded-md border px-3 py-2 font-mono text-sm break-all select-all">
                  {newToken}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => copy(newToken)}
                >
                  {copied ? (
                    <Check className="size-4 text-green-500" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                Use this token to configure your agent&apos;s connection to the
                proxy.
              </p>
            </div>
            <DialogFooter>
              <Button onClick={() => handleClose(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create agent</DialogTitle>
              <DialogDescription>
                Give your agent a name to identify it in the dashboard.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="space-y-2">
                <Label htmlFor="agent-name">Name</Label>
                <Input
                  id="agent-name"
                  placeholder="e.g. Production Claude"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && name.trim()) handleCreate();
                  }}
                  autoFocus
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => handleClose(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                disabled={!name.trim() || creating}
              >
                {creating ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
