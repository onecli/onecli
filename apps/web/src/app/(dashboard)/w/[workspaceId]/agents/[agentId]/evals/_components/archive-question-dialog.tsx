"use client";

import { Loader2 } from "lucide-react";
import { toast } from "sonner";
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
import { useArchiveEvalQuestion } from "@/hooks/use-evals";
import type { EvalQuestion } from "@/lib/api";

/** Confirm archiving a question: it leaves future runs, past results stay. */
export const ArchiveQuestionDialog = ({
  agentId,
  question,
  onClose,
}: {
  agentId: string;
  question: EvalQuestion | null;
  onClose: () => void;
}) => {
  const archive = useArchiveEvalQuestion(agentId);
  return (
    <AlertDialog
      open={question !== null}
      onOpenChange={(open) => {
        if (!open && !archive.isPending) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive this test question?</AlertDialogTitle>
          <AlertDialogDescription>
            “{question?.question}” will not be asked in future runs. Results of
            past runs are kept.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={archive.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={archive.isPending}
            // Keep the dialog open across the request (Radix would close it
            // on click) and close it once the archive resolves.
            onClick={(event) => {
              event.preventDefault();
              if (!question) return;
              archive.mutate(question.id, {
                onSuccess: () => {
                  toast.success("Test question archived");
                  onClose();
                },
                onError: (error) => toast.error(error.message),
              });
            }}
          >
            {archive.isPending && (
              <Loader2 className="animate-spin" aria-hidden />
            )}
            {archive.isPending ? "Archiving…" : "Archive"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
