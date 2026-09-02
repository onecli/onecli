"use client";

import { useEffect, useState } from "react";
import { Input } from "@onecli/ui/components/input";
import { Checkbox } from "@onecli/ui/components/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import type { RuleCondition } from "@onecli/api/validations/policy-rule";

export interface ConditionBuilderProps {
  conditions: RuleCondition[];
  onChange: (conditions: RuleCondition[]) => void;
}

export const ConditionBuilder = ({
  conditions,
  onChange,
}: ConditionBuilderProps) => {
  const first = conditions[0];
  const hasCondition =
    first?.target === "body" && first.operator === "contains";
  const currentValue = hasCondition ? first.value : "";

  const [enabled, setEnabled] = useState(hasCondition);
  const [value, setValue] = useState(currentValue);

  useEffect(() => {
    setEnabled(hasCondition);
    setValue(currentValue);
  }, [hasCondition, currentValue]);

  const handleToggle = (checked: boolean) => {
    setEnabled(checked);
    if (!checked) {
      onChange([]);
    } else if (value.trim()) {
      onChange([{ target: "body", operator: "contains", value: value.trim() }]);
    }
  };

  const handleChange = (v: string) => {
    setValue(v);
    if (enabled && v.trim()) {
      onChange([{ target: "body", operator: "contains", value: v.trim() }]);
    } else {
      onChange([]);
    }
  };

  return (
    <div className="flex items-center gap-2.5 flex-wrap">
      <Checkbox
        id="condition-toggle"
        checked={enabled}
        onCheckedChange={(checked) => handleToggle(checked === true)}
      />
      <span className="text-xs text-muted-foreground">When</span>
      <Select value="body" disabled={!enabled}>
        <SelectTrigger className="h-8 w-auto gap-1.5 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="body">request body</SelectItem>
        </SelectContent>
      </Select>
      <Select value="contains" disabled={!enabled}>
        <SelectTrigger className="h-8 w-auto gap-1.5 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="contains">contains</SelectItem>
        </SelectContent>
      </Select>
      <Input
        className="h-8 min-w-40 flex-1 text-xs"
        placeholder="e.g. DELETE, confidential"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        disabled={!enabled}
      />
    </div>
  );
};
