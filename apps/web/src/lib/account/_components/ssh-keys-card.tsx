"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { Card, CardContent } from "@onecli/ui/components/card";
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
import type { SshKey } from "@/lib/api";
import { useInstance } from "@/hooks/use-instance";
import { useSshKeys, useDeleteSshKey } from "@/hooks/use-ssh-keys";
import { AddSshKeyForm } from "./add-ssh-key-form";
import { SshKeyRow } from "./ssh-key-row";

/**
 * The registered-keys manager: add once, mint certificates from any agent's
 * SSH page. Gated on the instance's SSH posture exactly like the agent SSH
 * section: a deployment without the front door shows a quiet note, never a
 * teased dead registry. Loading (instance === null) falls through to the
 * manager — loading must never render as unavailable.
 */
export const SshKeysCard = () => {
  const instance = useInstance();
  const { data: keys = [], isPending, isError } = useSshKeys();
  const deleteMutation = useDeleteSshKey();
  const [deleteTarget, setDeleteTarget] = useState<SshKey | null>(null);

  if (instance !== null && instance.ssh === undefined) {
    return (
      <Card>
        <CardContent>
          <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-6 py-8 text-center">
            <KeyRound className="text-muted-foreground mb-1 size-5" />
            <p className="text-sm font-medium">
              SSH isn&apos;t available on this deployment
            </p>
            <p className="text-muted-foreground text-sm">
              Once the SSH front door is configured, register a key here to
              connect to your agents.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardContent className="space-y-5">
          <AddSshKeyForm />

          {/* A failed read must never render as the empty state — "No SSH
              keys yet" would be a negative claim off a failed query. */}
          {isPending ? (
            <p className="text-muted-foreground text-sm">Loading keys…</p>
          ) : isError ? (
            <p className="text-muted-foreground text-sm">
              Couldn&apos;t load your SSH keys. Refresh to try again.
            </p>
          ) : keys.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-6 py-8 text-center">
              <KeyRound className="text-muted-foreground mb-1 size-5" />
              <p className="text-sm font-medium">No SSH keys yet</p>
              <p className="text-muted-foreground text-sm">
                Register your public key once; it works for every agent you can
                reach.
              </p>
            </div>
          ) : (
            <div className="divide-y rounded-lg border">
              {keys.map((key) => (
                <SshKeyRow
                  key={key.id}
                  sshKey={key}
                  onDelete={() => setDeleteTarget(key)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete &quot;{deleteTarget?.name}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              New certificates can no longer be minted from this key.
              Certificates already minted keep working until they expire, and
              open sessions are not cut off.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (!deleteTarget) return;
                deleteMutation.mutate(deleteTarget.id, {
                  onSuccess: () => setDeleteTarget(null),
                });
              }}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
