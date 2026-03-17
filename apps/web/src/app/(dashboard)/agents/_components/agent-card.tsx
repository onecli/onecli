"use client";

import { useState } from "react";
import { MoreHorizontal, RotateCw, Trash2, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
import { Badge } from "@onecli/ui/components/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@onecli/ui/components/alert-dialog";
import { deleteAgent, regenerateAgentToken } from "@/lib/actions/agents";
import { ManageSecretsDialog } from "./manage-secrets-dialog";

interface AgentCardProps {
  agent: {
    id: string;
    name: string;
    accessToken: string;
    isDefault: boolean;
    secretMode: string;
    createdAt: Date;
    _count: { agentSecrets: number };
  };
  onUpdate: () => void;
}

export const AgentCard = ({ agent, onUpdate }: AgentCardProps) => {
  const [deleting, setDeleting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [rotateDialogOpen, setRotateDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [secretsDialogOpen, setSecretsDialogOpen] = useState(false);

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      await regenerateAgentToken(agent.id);
      onUpdate();
      toast.success("Token regenerated");
    } catch {
      toast.error("Failed to regenerate token");
    } finally {
      setRegenerating(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteAgent(agent.id);
      onUpdate();
      toast.success("Agent deleted");
    } catch {
      toast.error("Failed to delete agent");
    } finally {
      setDeleting(false);
    }
  };

  const secretsLabel =
    agent.secretMode === "selective"
      ? `${agent._count.agentSecrets} ${agent._count.agentSecrets === 1 ? "secret" : "secrets"}`
      : "All secrets";

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
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="text-muted-foreground">
              Created {new Date(agent.createdAt).toLocaleDateString()}
            </span>
            <button
              type="button"
              onClick={() => setSecretsDialogOpen(true)}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 transition-colors"
            >
              <KeyRound className="size-3" />
              {secretsLabel}
            </button>
          </div>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setSecretsDialogOpen(true)}>
              <KeyRound className="size-4" />
              Manage secrets
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setRotateDialogOpen(true)}>
              <RotateCw className="size-4" />
              Rotate token
            </DropdownMenuItem>
            {!agent.isDefault && (
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setDeleteDialogOpen(true)}
              >
                <Trash2 className="size-4" />
                Delete agent
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog open={rotateDialogOpen} onOpenChange={setRotateDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate token?</AlertDialogTitle>
            <AlertDialogDescription>
              The current token for <strong>{agent.name}</strong> will be
              invalidated immediately. Any agents using the old token will lose
              access.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRegenerate}
              disabled={regenerating}
            >
              {regenerating ? "Rotating..." : "Rotate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete agent?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <strong>{agent.name}</strong> and its
              access token. This action cannot be undone.
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

      <ManageSecretsDialog
        agent={agent}
        open={secretsDialogOpen}
        onOpenChange={setSecretsDialogOpen}
        onUpdated={onUpdate}
      />
    </Card>
  );
};
