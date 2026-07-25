import { Users } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import type { PolicyRuleView } from "./policy-rule-display";

interface IdentityCellProps {
  rule: Pick<PolicyRuleView, "identities">;
  identityName: (id: string) => string;
}

/** "All agents" (the quiet common case) or specific-agent chips with overflow. */
export const IdentityCell = ({ rule, identityName }: IdentityCellProps) => {
  if (rule.identities.length === 0) {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
        <Users className="size-3.5 shrink-0" aria-hidden />
        All agents
      </span>
    );
  }
  const shown = rule.identities.slice(0, 2);
  const extra = rule.identities.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((identity) => (
        <Badge
          key={identity.id}
          variant="outline"
          className="max-w-[140px] rounded-md text-[11px] font-normal"
        >
          <span className="truncate">{identityName(identity.id)}</span>
        </Badge>
      ))}
      {extra > 0 && (
        <span className="text-muted-foreground text-[11px]">+{extra} more</span>
      )}
    </div>
  );
};
