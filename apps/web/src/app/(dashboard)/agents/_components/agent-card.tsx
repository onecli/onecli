"use client";

import { useState } from "react";
import { Eye, EyeOff, Copy, Check, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
import { Badge } from "@onecli/ui/components/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@onecli/ui/components/alert-dialog";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useAuth } from "@/providers/auth-provider";
import { deleteAgent, regenerateAgentToken } from "@/lib/actions/agents";

interface AgentCardProps {
  agent: {
    id: string;
    name: string;
    accessToken: string;
    isDefault: boolean;
    createdAt: Date;
    _count: { policies: number };
  };
  onUpdate: () => void;
}

export const AgentCard = ({ agent, onUpdate }: AgentCardProps) => {
  const { user } = useAuth();
  const [revealed, setRevealed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const { copied, copy } = useCopyToClipboard();

  const truncatedToken = `${agent.accessToken.slice(0, 8)}${"•".repeat(12)}${agent.accessToken.slice(-4)}`;

  const handleRegenerate = async () => {
    if (!user?.id) return;
    setRegenerating(true);
    try {
      await regenerateAgentToken(agent.id, user.id);
      setRevealed(false);
      onUpdate();
      toast.success("Token regenerated");
    } catch {
      toast.error("Failed to regenerate token");
    } finally {
      setRegenerating(false);
    }
  };

  const handleDelete = async () => {
    if (!user?.id) return;
    setDeleting(true);
    try {
      await deleteAgent(agent.id, user.id);
      onUpdate();
      toast.success("Agent deleted");
    } catch {
      toast.error("Failed to delete agent");
    } finally {
      setDeleting(false);
    }
  };

  const policyCount = agent._count.policies;

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">{agent.name}</h3>
            {agent.isDefault && (
              <Badge variant="outline" className="text-xs">
                Default
              </Badge>
            )}
            <Badge variant="secondary" className="text-xs">
              {policyCount} {policyCount === 1 ? "policy" : "policies"}
            </Badge>
          </div>

          <div className="flex items-center gap-2">
            <code className="bg-muted flex-1 truncate rounded-md border px-3 py-1.5 font-mono text-xs select-none">
              {revealed ? agent.accessToken : truncatedToken}
            </code>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => setRevealed(!revealed)}
            >
              {revealed ? (
                <EyeOff className="size-3.5" />
              ) : (
                <Eye className="size-3.5" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => copy(agent.accessToken)}
            >
              {copied ? (
                <Check className="size-3.5 text-green-500" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </Button>
          </div>

          <p className="text-muted-foreground text-xs">
            Created {new Date(agent.createdAt).toLocaleDateString()}
          </p>
        </div>

        <div className="flex items-center gap-1">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7">
                <RefreshCw
                  className={`size-3.5 ${regenerating ? "animate-spin" : ""}`}
                />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Regenerate token?</AlertDialogTitle>
                <AlertDialogDescription>
                  The current token for <strong>{agent.name}</strong> will be
                  invalidated immediately. Any agents using the old token will
                  lose access.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleRegenerate}
                  disabled={regenerating}
                >
                  {regenerating ? "Regenerating..." : "Regenerate"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {!agent.isDefault && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7">
                  <Trash2 className="size-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete agent?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete <strong>{agent.name}</strong>{" "}
                    and all its policies. This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={handleDelete}
                    disabled={deleting}
                  >
                    {deleting ? "Deleting..." : "Delete"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>
    </Card>
  );
};
