"use client";

import { Plus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { RuleCard, type RuleDraft } from "./rule-card";

export interface RuleListProps {
  rules: RuleDraft[];
  onChange: (rules: RuleDraft[]) => void;
  disabled?: boolean;
}

/**
 * The list of availability rules (restricted mode): a card per rule + an "Add
 * rule" button. A person's available apps are the union of every rule that names
 * them, so rules are unordered.
 */
export const RuleList = ({ rules, onChange, disabled }: RuleListProps) => {
  const updateRule = (key: string, patch: Partial<RuleDraft>) =>
    onChange(rules.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeRule = (key: string) =>
    onChange(rules.filter((r) => r.key !== key));
  const addRule = () =>
    onChange([
      ...rules,
      {
        key: crypto.randomUUID(),
        name: "",
        userIds: [],
        groupIds: [],
        providers: [],
      },
    ]);

  return (
    <div className="space-y-3">
      {rules.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No rules yet. Add a rule, choose the people it applies to, and the
          apps they may connect.
        </p>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <RuleCard
              key={rule.key}
              rule={rule}
              onChange={(patch) => updateRule(rule.key, patch)}
              onRemove={() => removeRule(rule.key)}
              disabled={disabled}
            />
          ))}
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={addRule}
        className="font-normal"
      >
        <Plus className="size-4" />
        Add rule
      </Button>
    </div>
  );
};
