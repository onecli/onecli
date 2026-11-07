"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { useSaveEvalQuestion } from "@/hooks/use-evals";
import type { EvalQuestion } from "@/lib/api";
import { QuestionForm } from "./question-form";
import { useAgentEvalApps } from "./use-agent-eval-apps";

export interface QuestionDialogState {
  open: boolean;
  /** The question being edited, or null to add one. */
  editing: EvalQuestion | null;
  /** Bumped on every open, so the form remounts with fresh state. */
  key: number;
}

/**
 * Add or edit one test question. The agent's apps load only while it is
 * open, and it cannot be dismissed while a save is in flight.
 */
export const QuestionDialog = ({
  agentId,
  state,
  onClose,
}: {
  agentId: string;
  state: QuestionDialogState;
  onClose: () => void;
}) => {
  const save = useSaveEvalQuestion(agentId);
  const apps = useAgentEvalApps(agentId, state.open);
  const close = () => {
    save.reset();
    onClose();
  };
  return (
    <Dialog
      open={state.open}
      onOpenChange={(open) => {
        if (!open && !save.isPending) close();
      }}
    >
      <DialogContent
        className="flex flex-col overflow-hidden sm:max-w-lg"
        showCloseButton={!save.isPending}
      >
        <DialogHeader>
          <DialogTitle>
            {state.editing ? "Edit test question" : "Add test question"}
          </DialogTitle>
          <DialogDescription>
            A question you know the answer to, and how to check the answer.
          </DialogDescription>
        </DialogHeader>
        <QuestionForm
          key={state.key}
          editing={state.editing}
          save={save}
          apps={apps}
          onDone={close}
        />
      </DialogContent>
    </Dialog>
  );
};
