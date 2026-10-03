"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Checkbox } from "@onecli/ui/components/checkbox";
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
import { Input } from "@onecli/ui/components/input";
import { useAuth } from "@/providers/auth-provider";
import { useAccountDeletionImpact, useDeleteAccount } from "@/hooks/use-user";
import type { AccountDeletionOrgImpact } from "@/lib/api";

interface Props {
  email: string;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

const outcomeLabel = (impact: AccountDeletionOrgImpact) => {
  switch (impact.outcome) {
    case "delete":
      return impact.workspaces.length === 0
        ? "Organization will be deleted"
        : `Organization and ${plural(impact.workspaces.length, "workspace")} will be deleted`;
    case "leave":
      return impact.workspaces.length === 0
        ? "You will leave this organization"
        : `You will leave; ${plural(impact.workspaces.length, "personal workspace")} will be deleted`;
    case "blocked":
      return `You own this organization and ${plural(impact.otherMemberCount, "other member")} depend on it`;
  }
};

export const DeleteAccountCard = ({ email }: Props) => {
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const [confirmText, setConfirmText] = useState("");
  const { signOut } = useAuth();
  const router = useRouter();

  // Always ask the server while the dialog is open: a server-rendered "has
  // orgs" flag can go stale (the user joined or created an org after the page
  // loaded), and the action must never destroy something the dialog did not
  // show.
  const impact = useAccountDeletionImpact(open);
  const deleteAccount = useDeleteAccount();
  const pending = deleteAccount.isPending;

  const impacts = impact.data ?? [];
  const blocked = impacts.filter((i) => i.outcome === "blocked");
  const actionable = impacts.filter((i) => i.outcome !== "blocked");
  const allAcknowledged = actionable.every((i) =>
    acknowledged.has(i.organizationId),
  );
  // A settled, CURRENT list: while a refetch is in flight (the dialog was
  // reopened, or focus came back) the previous list must not be acknowledged.
  const settled = impact.isSuccess && !impact.isFetching;
  const canConfirm =
    settled &&
    blocked.length === 0 &&
    allAcknowledged &&
    confirmText.trim() === email &&
    !pending;

  const reset = () => {
    setConfirmText("");
    setAcknowledged(new Set());
  };

  const toggle = (organizationId: string, checked: boolean) => {
    setAcknowledged((prev) => {
      const next = new Set(prev);
      if (checked) next.add(organizationId);
      else next.delete(organizationId);
      return next;
    });
  };

  const handleDelete = () => {
    if (!canConfirm) return;
    deleteAccount.mutate(undefined, {
      onSuccess: async () => {
        await signOut();
        router.replace("/auth/login");
      },
      onError: (err) =>
        toast.error(
          err instanceof Error ? err.message : "Failed to delete account",
        ),
    });
  };

  return (
    <>
      <Card className="border-destructive/40 p-6">
        <div className="flex flex-col gap-4">
          <div>
            <h3 className="text-base font-semibold">Delete account</h3>
            <p className="text-muted-foreground text-sm">
              Permanently delete your account, the organizations only you belong
              to, and your personal workspaces. This action cannot be undone.
            </p>
          </div>
          <div className="flex justify-end">
            <Button
              variant="destructive"
              onClick={() => {
                reset();
                setOpen(true);
              }}
            >
              Delete account
            </Button>
          </div>
        </div>
      </Card>

      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete account</AlertDialogTitle>
            <AlertDialogDescription>
              {actionable.length > 0
                ? "Acknowledge what happens to each organization you belong to:"
                : "Deleting your account is permanent and cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {impact.isPending || impact.isFetching ? (
            <p role="status" className="text-muted-foreground text-sm">
              Checking your organizations…
            </p>
          ) : impact.isError ? (
            <div
              role="alert"
              className="border-destructive/40 bg-destructive/5 flex items-center justify-between gap-3 rounded-md border p-3 text-sm"
            >
              <span>
                {impact.error instanceof Error
                  ? impact.error.message
                  : "Failed to load your organizations"}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => impact.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : (
            <>
              {blocked.length > 0 && (
                <div className="border-destructive/40 bg-destructive/5 rounded-md border p-3 text-sm">
                  <p className="font-medium">
                    Transfer ownership or remove members first
                  </p>
                  <ul className="text-muted-foreground mt-1 list-disc pl-5">
                    {blocked.map((i) => (
                      <li key={i.organizationId}>
                        <span className="text-foreground font-medium">
                          {i.name}
                        </span>{" "}
                        · {outcomeLabel(i)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {actionable.length > 0 && (
                <div className="flex flex-col gap-2">
                  {actionable.map((i) => {
                    const id = `ack-org-${i.organizationId}`;
                    return (
                      <label
                        key={i.organizationId}
                        htmlFor={id}
                        className="hover:bg-muted/50 flex cursor-pointer items-start gap-3 rounded-md border p-3"
                      >
                        <Checkbox
                          id={id}
                          checked={acknowledged.has(i.organizationId)}
                          onCheckedChange={(c) =>
                            toggle(i.organizationId, c === true)
                          }
                          disabled={pending || blocked.length > 0}
                          className="mt-0.5"
                        />
                        <div className="flex flex-col gap-1 text-sm">
                          <span className="font-medium">{i.name}</span>
                          <span className="text-muted-foreground">
                            {outcomeLabel(i)}
                          </span>
                          {i.workspaces.length > 0 && (
                            <span className="text-muted-foreground text-xs">
                              {i.workspaces
                                .map((w) => w.name ?? "Untitled")
                                .join(", ")}
                            </span>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}

              {blocked.length === 0 && (
                <div className="grid gap-2 py-2">
                  <p className="text-sm font-medium">
                    Type{" "}
                    <code className="bg-muted cursor-text select-text rounded px-1.5 py-0.5 font-mono">
                      {email}
                    </code>{" "}
                    to confirm.
                  </p>
                  <Input
                    id="confirm-account-delete"
                    placeholder="Enter your email address"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    disabled={pending}
                  />
                </div>
              )}
            </>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            {settled && blocked.length === 0 && (
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  handleDelete();
                }}
                disabled={!canConfirm}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {pending ? "Deleting..." : "I understand, delete my account"}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
