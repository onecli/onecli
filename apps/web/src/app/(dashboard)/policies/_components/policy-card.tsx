"use client";

import { useState } from "react";
import { ArrowRight, Pencil, Trash2 } from "lucide-react";
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
import { useAuth } from "@/providers/auth-provider";
import { deletePolicy } from "@/lib/actions/policies";
import { EditPolicyDialog } from "./edit-policy-dialog";

interface PolicyCardProps {
  policy: {
    id: string;
    createdAt: Date;
    agent: { id: string; name: string };
    secret: { id: string; name: string; type: string; hostPattern: string };
  };
  onUpdate: () => void;
}

export const PolicyCard = ({ policy, onUpdate }: PolicyCardProps) => {
  const { user } = useAuth();
  const [deleting, setDeleting] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const handleDelete = async () => {
    if (!user?.id) return;
    setDeleting(true);
    try {
      await deletePolicy(policy.id, user.id);
      onUpdate();
      toast.success("Policy deleted");
    } catch {
      toast.error("Failed to delete policy");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Card className="p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="text-xs font-medium">
                {policy.agent.name}
              </Badge>
              <ArrowRight className="text-muted-foreground size-3.5 shrink-0" />
              <Badge variant="outline" className="text-xs font-medium">
                {policy.secret.name}
              </Badge>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="text-muted-foreground">
                Host:{" "}
                <code className="bg-muted rounded px-1 py-0.5 font-mono">
                  {policy.secret.hostPattern}
                </code>
              </span>
              <span className="text-muted-foreground">
                Created {new Date(policy.createdAt).toLocaleDateString()}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => setEditOpen(true)}
            >
              <Pencil className="size-3.5" />
            </Button>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7">
                  <Trash2 className="size-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete policy?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will remove <strong>{policy.agent.name}</strong>&apos;s
                    access to <strong>{policy.secret.name}</strong>. The agent
                    and secret will not be deleted.
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
          </div>
        </div>
      </Card>

      <EditPolicyDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        policy={policy}
        onUpdated={onUpdate}
      />
    </>
  );
};
