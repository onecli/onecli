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
        // Never held by an in-flight archive: archiving is instant.
        if (!open) onClose();
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
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            // Instant: the question leaves the list and the confirm closes
            // on click; the hook confirms, or puts it back and says why.
            onClick={() => {
              if (!question) return;
              archive.mutate(question.id);
              onClose();
            }}
          >
            Archive
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
