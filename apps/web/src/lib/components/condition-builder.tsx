"use client";

import type { RuleCondition } from "@onecli/api/validations/policy-rule";

export interface ConditionBuilderProps {
  conditions: RuleCondition[];
  onChange: (conditions: RuleCondition[]) => void;
}

export const ConditionBuilder = ({}: ConditionBuilderProps) => (
  <div className="rounded-md border border-dashed px-3 py-2.5">
    <p className="text-xs text-muted-foreground">
      Match conditions (body content, headers) are available on{" "}
      <a
        href="https://app.onecli.sh"
        target="_blank"
        rel="noopener noreferrer"
        className="underline"
      >
        OneCLI Cloud
      </a>
      .
    </p>
  </div>
);
