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

/** Destructive-confirm for removing a custom rule. Deletion stages into the draft
 * like any edit — it takes effect on the next Publish. */
export const DeleteRuleDialog = ({
  rule,
  onOpenChange,
  onConfirm,
  loading,
}: DeleteRuleDialogProps) => (
  <AlertDialog open={rule !== null} onOpenChange={onOpenChange}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Delete this rule?</AlertDialogTitle>
        <AlertDialogDescription>
          {rule
            ? `“${rule.name}” will be removed from the draft. It takes effect when you publish.`
            : ""}
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
          {loading ? "Deleting…" : "Delete Rule"}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);
