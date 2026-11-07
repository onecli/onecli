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

export interface RemoveLibrarySkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onConfirm: () => void;
}

/** "Remove … from this agent?": the skill leaves this agent only. It stays
 * in the repo and can be added again from the library. */
export const RemoveLibrarySkillDialog = ({
  open,
  onOpenChange,
  name,
  onConfirm,
}: RemoveLibrarySkillDialogProps) => (
  <AlertDialog open={open} onOpenChange={onOpenChange}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Remove “{name}” from this agent?</AlertDialogTitle>
        <AlertDialogDescription>
          The agent stops using it within seconds. It stays in the repo, so you
          can add it again from the library.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive" onClick={onConfirm}>
          Remove
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);
