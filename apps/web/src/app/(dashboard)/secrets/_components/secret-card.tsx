"use client";

import { useState } from "react";
import { useInvalidateGatewayCache } from "@/hooks/use-invalidate-cache";
import { Pencil, Trash2 } from "lucide-react";
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
import { deleteSecret } from "@/lib/actions/secrets";
import { SecretDialog } from "./secret-dialog";

interface InjectionConfig {
  headerName: string;
  valueFormat: string;
}

interface SecretCardProps {
  secret: {
    id: string;
    name: string;
    type: string;
    typeLabel: string;
    hostPattern: string;
    pathPattern: string | null;
    injectionConfig: unknown;
    createdAt: Date;
  };
  onUpdate: () => void;
}

export const SecretCard = ({ secret, onUpdate }: SecretCardProps) => {
  const invalidateCache = useInvalidateGatewayCache();
  const [deleting, setDeleting] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteSecret(secret.id);
      onUpdate();
      invalidateCache();
      toast.success("Secret deleted");
    } catch {
      toast.error("Failed to delete secret");
    } finally {
      setDeleting(false);
    }
  };

  const config = secret.injectionConfig as InjectionConfig | null;

  return (
    <>
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium">{secret.name}</h3>
              <Badge variant="secondary" className="text-xs">
                {secret.typeLabel}
              </Badge>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="text-muted-foreground">
                Host:{" "}
                <code className="bg-muted rounded px-1 py-0.5 font-mono">
                  {secret.hostPattern}
                </code>
              </span>
              {secret.pathPattern && (
                <span className="text-muted-foreground">
                  Path:{" "}
                  <code className="bg-muted rounded px-1 py-0.5 font-mono">
                    {secret.pathPattern}
                  </code>
                </span>
              )}
              {secret.type === "generic" && config?.headerName && (
                <span className="text-muted-foreground">
                  Header:{" "}
                  <code className="bg-muted rounded px-1 py-0.5 font-mono">
                    {config.headerName}
                  </code>
                </span>
              )}
            </div>

            <p className="text-muted-foreground text-xs">
              Created {new Date(secret.createdAt).toLocaleDateString()}
            </p>
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
                  <AlertDialogTitle>Delete secret?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete <strong>{secret.name}</strong>{" "}
                    and its encrypted value. This action cannot be undone.
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

      <SecretDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        secret={secret}
        onSaved={onUpdate}
      />
    </>
  );
};
