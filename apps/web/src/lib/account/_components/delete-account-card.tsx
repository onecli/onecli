"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
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
import { deleteAccountAction } from "../actions";

interface Props {
  email: string;
  hasOrgs: boolean;
}

export const DeleteAccountCard = ({ email, hasOrgs }: Props) => {
  const [open, setOpen] = useState(false);
  const [orgWarningOpen, setOrgWarningOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [pending, startTransition] = useTransition();
  const { signOut } = useAuth();
  const router = useRouter();

  const canConfirm = confirmText.trim() === email && !pending;

  const handleRequestDelete = () => {
    if (hasOrgs) {
      setOrgWarningOpen(true);
    } else {
      setConfirmText("");
      setOpen(true);
    }
  };

  const handleDelete = () => {
    if (!canConfirm) return;
    startTransition(async () => {
      const result = await deleteAccountAction();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await signOut();
      router.replace("/auth/login");
    });
  };

  return (
    <>
      <Card className="border-destructive/40 p-6">
        <div className="flex flex-col gap-4">
          <div>
            <h3 className="text-base font-semibold">Delete account</h3>
            <p className="text-muted-foreground text-sm">
              Permanently delete your account and all associated data. This
              action cannot be undone.
            </p>
          </div>
          <div className="flex justify-end">
            <Button variant="destructive" onClick={handleRequestDelete}>
              Delete account
            </Button>
          </div>
        </div>
      </Card>

      <AlertDialog open={orgWarningOpen} onOpenChange={setOrgWarningOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Leave all organizations before requesting account deletion
            </AlertDialogTitle>
            <AlertDialogDescription>
              You need to leave or delete all your organizations before you can
              delete your account.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setOrgWarningOpen(false)}>
              Understood
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setConfirmText("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Are you sure you want to delete your account?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Deleting your account is permanent and <strong>cannot</strong> be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-2 py-2">
            <p className="text-sm font-medium">
              Please type{" "}
              <code className="bg-muted cursor-text select-text rounded px-1.5 py-0.5 font-mono">
                {email}
              </code>{" "}
              to confirm
            </p>
            <Input
              id="confirm-account-delete"
              placeholder="Enter your email address"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoFocus
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
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
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
