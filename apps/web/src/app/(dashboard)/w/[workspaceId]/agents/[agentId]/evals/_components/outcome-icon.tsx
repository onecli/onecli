import {
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { EvalOutcome } from "@onecli/api/validations/evals";
import { cn } from "@onecli/ui/lib/utils";
import { OUTCOME_LABEL } from "./eval-copy";

const ICON: Record<EvalOutcome, LucideIcon> = {
  passed: CheckCircle2,
  mismatch: XCircle,
  error: CircleMinus,
  inconclusive: CircleHelp,
  pending: CircleDashed,
};

/** Color is never the only signal: each outcome has its own icon shape. */
export const OUTCOME_TONE: Record<EvalOutcome, string> = {
  passed: "text-emerald-700 dark:text-emerald-400",
  mismatch: "text-destructive",
  error: "text-destructive",
  inconclusive: "text-muted-foreground",
  pending: "text-muted-foreground",
};

/** An outcome's icon, named for screen readers unless `decorative`. */
export const OutcomeIcon = ({
  outcome,
  decorative = false,
  className,
}: {
  outcome: EvalOutcome;
  decorative?: boolean;
  className?: string;
}) => {
  const Icon = ICON[outcome];
  return (
    <Icon
      className={cn("size-4 shrink-0", OUTCOME_TONE[outcome], className)}
      {...(decorative
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": OUTCOME_LABEL[outcome] })}
    />
  );
};
