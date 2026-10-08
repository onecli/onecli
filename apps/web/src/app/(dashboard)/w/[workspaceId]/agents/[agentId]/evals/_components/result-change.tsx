import type { EvalChange } from "@onecli/api/validations/evals";
import { Badge } from "@onecli/ui/components/badge";

const CHANGE: Record<
  EvalChange,
  { label: string; variant: "outline" | "destructive" | "secondary" } | null
> = {
  same: null,
  new: { label: "New or edited", variant: "secondary" },
  fixed: { label: "Fixed since last run", variant: "outline" },
  regressed: { label: "Broke since last run", variant: "destructive" },
};

/** How a result moved since the previous completed run, when it moved. */
export const ResultChange = ({ change }: { change: EvalChange | null }) => {
  const shown = change && CHANGE[change];
  if (!shown) return null;
  return (
    <Badge variant={shown.variant} className="text-[11px]">
      {shown.label}
    </Badge>
  );
};
