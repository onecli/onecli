"use client";

import { ChevronDown, Plus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@onecli/ui/components/collapsible";
import type { EvalQuestion } from "@/lib/api";
import { plural } from "./eval-copy";
import { QuestionRow } from "./question-row";

/** The test questions, folded once results exist (results come first). */
export const QuestionList = ({
  questions,
  maxQuestions,
  open,
  onOpenChange,
  appLabel,
  onAdd,
  onEdit,
  onArchive,
}: {
  questions: EvalQuestion[];
  maxQuestions: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appLabel: (id: string) => string;
  onAdd: () => void;
  onEdit: (question: EvalQuestion) => void;
  onArchive: (question: EvalQuestion) => void;
}) => {
  const full = questions.length >= maxQuestions;
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3>
          <CollapsibleTrigger asChild>
            <Button size="sm" variant="ghost" className="group -ms-2">
              <ChevronDown className="transition-transform group-data-[state=closed]:-rotate-90" />
              Test questions
              <span className="text-muted-foreground tabular-nums">
                {questions.length}/{maxQuestions}
              </span>
            </Button>
          </CollapsibleTrigger>
        </h3>
        <Button
          size="sm"
          variant="outline"
          onClick={onAdd}
          disabled={full}
          title={
            full
              ? `An agent can have ${maxQuestions} test questions`
              : undefined
          }
        >
          <Plus />
          Add question
        </Button>
      </div>
      <CollapsibleContent>
        {questions.length === 0 ? (
          <p className="text-muted-foreground py-2 text-sm">
            Add a question you know the answer to, like “How many customers do
            we have?”.
          </p>
        ) : (
          <ul
            aria-label={plural(
              questions.length,
              "test question",
              "test questions",
            )}
            className="divide-y rounded-md border"
          >
            {questions.map((question) => (
              <QuestionRow
                key={question.id}
                question={question}
                appLabel={appLabel}
                onEdit={() => onEdit(question)}
                onArchive={() => onArchive(question)}
              />
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
};
