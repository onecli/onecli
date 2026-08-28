"use client";

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
import { buttonVariants } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import type { PolicyRuleV2 } from "@/lib/api";

export interface DeleteRuleDialogProps {
  /** The rule pending deletion, or null when the dialog is closed. */
  rule: PolicyRuleV2 | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  loading: boolean;
}

/** Destructive-confirm for removing a rule. Deletion stages into the draft like
 * any edit — it takes effect on the next Publish.
 *
 * An `equipment` rule is a credential GRANT, not a permission: deleting it takes
 * a credential away from an agent, which the generic "delete this rule" wording
 * gives no hint of. It gets its own copy. */
export const DeleteRuleDialog = ({
  rule,
  onOpenChange,
  onConfirm,
  loading,
}: DeleteRuleDialogProps) => {
  const isGrant = rule?.source === "equipment" || rule?.source === "grant";
  return (
    <AlertDialog open={rule !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isGrant ? "Revoke this credential grant?" : "Delete this rule?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {!rule
              ? ""
              : isGrant
                ? `The agents named by “${rule.name}” will stop receiving this credential. Requests that need it will fail.`
                : `“${rule.name}” will be removed.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={loading}
            className={cn(buttonVariants({ variant: "destructive" }))}
          >
            {loading
              ? isGrant
                ? "Revoking…"
                : "Deleting…"
              : isGrant
                ? "Revoke Grant"
                : "Delete Rule"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
