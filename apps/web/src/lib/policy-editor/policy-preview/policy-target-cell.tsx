import { Boxes, Globe } from "lucide-react";
import type { PolicyRuleTarget } from "@/lib/api";
import { targetText } from "./policy-rule-display";

const TargetChip = ({ target }: { target: PolicyRuleTarget }) => {
  if (target.kind === "network") {
    return (
      <span className="bg-muted text-foreground inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-xs">
        <Globe className="text-muted-foreground size-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{targetText(target)}</span>
      </span>
    );
  }
  return (
    <span className="bg-muted text-foreground inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-xs">
      <Boxes className="text-muted-foreground size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{targetText(target)}</span>
    </span>
  );
};

interface TargetCellProps {
  targets: PolicyRuleTarget[];
  /** Dialog shows every target (wrapped); the row shows one chip + "+N more". */
  full?: boolean;
}

export const TargetCell = ({ targets, full = false }: TargetCellProps) => {
  const [first, ...rest] = targets;
  if (!first) {
    return <span className="text-muted-foreground text-xs">Any</span>;
  }
  if (full) {
    return (
      <div className="flex flex-wrap gap-1">
        {targets.map((target, i) => (
          <TargetChip key={i} target={target} />
        ))}
      </div>
    );
  }
  const extra = rest.length;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <TargetChip target={first} />
      {extra > 0 && (
        <span className="text-muted-foreground shrink-0 text-[11px]">
          +{extra} more
        </span>
      )}
    </div>
  );
};
