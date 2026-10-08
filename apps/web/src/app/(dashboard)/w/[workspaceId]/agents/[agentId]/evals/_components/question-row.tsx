"use client";

import { Pencil, Trash2 } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import type { EvalQuestion } from "@/lib/api";
import { CHECK_LABEL } from "./eval-copy";

/** One test question: what is asked, what is expected, and its checks. */
export const QuestionRow = ({
  question,
  appLabel,
  onEdit,
  onArchive,
}: {
  question: EvalQuestion;
  appLabel: (id: string) => string;
  onEdit: () => void;
  onArchive: () => void;
}) => (
  <li className="flex items-start gap-2 p-3 sm:px-4">
    <div className="min-w-0 flex-1 space-y-1.5">
      <p className="text-sm break-words">{question.question}</p>
      <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
        <span>Expected</span>
        <code className="text-foreground font-mono break-all">
          {question.expected}
        </code>
        <Badge variant="outline" className="text-[11px]">
          {CHECK_LABEL[question.kind]}
        </Badge>
        {question.expectedApps.map((app) => (
          <Badge key={app} variant="secondary" className="text-[11px]">
            {appLabel(app)}
          </Badge>
        ))}
      </div>
    </div>
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={`Edit test question: ${question.question}`}
      onClick={onEdit}
    >
      <Pencil />
    </Button>
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={`Archive test question: ${question.question}`}
      onClick={onArchive}
    >
      <Trash2 />
    </Button>
  </li>
);
