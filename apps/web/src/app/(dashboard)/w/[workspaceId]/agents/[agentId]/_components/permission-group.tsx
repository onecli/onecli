"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import type { AppToolGroupSummary } from "@onecli/api/apps/app-permissions/types";
import type {
  EffectiveToolResult,
  OrgCeilingVerdict,
} from "@/lib/api/policy-visibility";
import { PermissionToolRow } from "./permission-tool-row";
import type { ToolChoice } from "./tri-state-control";

const GROUP_LABELS: Record<"read" | "write", string> = {
  read: "Read-only",
  write: "Write / delete",
};

const GROUP_OPTIONS: { value: ToolChoice; label: string }[] = [
  { value: "allow", label: "Always allow" },
  { value: "ask", label: "Needs approval" },
  { value: "never", label: "Never" },
];

const isToolChoice = (value: string): value is ToolChoice =>
  GROUP_OPTIONS.some((o) => o.value === value);

interface PermissionGroupProps {
  group: AppToolGroupSummary;
  choices: Record<string, ToolChoice>;
  ceilings: Record<string, OrgCeilingVerdict | null>;
  effective: Record<string, EffectiveToolResult>;
  readOnly: boolean;
  askLocked: boolean;
  onToolSelect: (toolId: string, choice: ToolChoice) => void;
  /** Applies to every tool in the group the ceiling allows to change. */
  onGroupSelect: (toolIds: string[], choice: ToolChoice) => void;
}

export const PermissionGroup = ({
  group,
  choices,
  ceilings,
  effective,
  readOnly,
  askLocked,
  onToolSelect,
  onGroupSelect,
}: PermissionGroupProps) => {
  // Group-level actions always EXPAND to the concrete tool ids — never the
  // catalog's wildcard alias (the grants validator rejects wildcard ids).
  const toolIds = group.tools.map((t) => t.id);

  const optionDisabled = (value: ToolChoice): boolean =>
    group.tools.some((t) => {
      const ceiling = ceilings[t.id] ?? null;
      if (ceiling === "block") return true;
      return ceiling === "approval" && value === "allow";
    });

  const uniform =
    toolIds.length > 0 &&
    toolIds.every((id) => choices[id] === choices[toolIds[0] ?? ""])
      ? (choices[toolIds[0] ?? ""] ?? "never")
      : null;

  const allLocked = group.tools.every((t) => ceilings[t.id] === "block");

  return (
    <section aria-label={GROUP_LABELS[group.category]}>
      <div className="flex items-center justify-between gap-3 border-b pb-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">
            {GROUP_LABELS[group.category]}
          </h3>
          <span className="text-muted-foreground bg-muted rounded px-1.5 py-0.5 text-[10px]">
            {group.tools.length}
          </span>
        </div>
        <Select
          value={uniform ?? "custom"}
          onValueChange={(value) => {
            if (!isToolChoice(value)) return;
            onGroupSelect(toolIds, value);
          }}
          disabled={readOnly || allLocked}
        >
          <SelectTrigger
            size="sm"
            className="text-muted-foreground h-7 border-none bg-transparent shadow-none dark:bg-transparent"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {uniform === null && (
              <SelectItem value="custom" disabled>
                Custom
              </SelectItem>
            )}
            {GROUP_OPTIONS.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                disabled={optionDisabled(option.value)}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="divide-y">
        {group.tools.map((tool) => (
          <PermissionToolRow
            key={tool.id}
            tool={tool}
            choice={choices[tool.id] ?? "never"}
            ceiling={ceilings[tool.id] ?? null}
            effective={effective[tool.id]}
            readOnly={readOnly}
            askLocked={askLocked}
            onSelect={(choice) => onToolSelect(tool.id, choice)}
          />
        ))}
      </div>
    </section>
  );
};
