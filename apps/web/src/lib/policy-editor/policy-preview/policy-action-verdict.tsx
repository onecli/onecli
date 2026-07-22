import { Gauge, Hand } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
import {
  actionMeta,
  rateLimitLabel,
  type PolicyRuleView,
} from "./policy-rule-display";

/**
 * The row / dialog verdict: a calm semantic icon + label (never color alone),
 * with rate-limit and approval surfaced as small secondary modifier chips.
 */
export const ActionVerdict = ({ rule }: { rule: PolicyRuleView }) => {
  const { Icon, label, className } = actionMeta(rule);
  // Modifiers only qualify an allow; guard so a future "block + modifier" can
  // never render a contradictory verdict.
  const isAllow = rule.action === "allow";
  const rate = isAllow ? rateLimitLabel(rule) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <span
        className={cn(
          "inline-flex items-center gap-1.5 text-xs font-medium",
          className,
        )}
      >
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {label}
      </span>
      {rate && (
        <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
          <Gauge
            className="size-3 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden
          />
          {rate}
        </span>
      )}
      {isAllow && rule.requireApproval && (
        <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
          <Hand
            className="size-3 shrink-0 text-blue-600 dark:text-blue-400"
            aria-hidden
          />
          Approval
        </span>
      )}
    </div>
  );
};
