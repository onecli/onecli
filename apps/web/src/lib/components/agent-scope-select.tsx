"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";

const ALL_AGENTS = "_all";

export interface AgentScopeSelectProps {
  agents: { id: string; name: string }[];
  /** Selected agent id; "" means all agents. */
  value: string;
  onChange: (agentId: string) => void;
  /** Per-agent override counts, rendered as a muted suffix when > 0. */
  overrideCounts?: Record<string, number>;
  disabled?: boolean;
  triggerClassName?: string;
  /** Accessible name for label-less placements (e.g. section headers). */
  ariaLabel?: string;
}

export const AgentScopeSelect = ({
  agents,
  value,
  onChange,
  overrideCounts,
  disabled,
  triggerClassName,
  ariaLabel,
}: AgentScopeSelectProps) => (
  <Select
    value={value || ALL_AGENTS}
    onValueChange={(v) => onChange(v === ALL_AGENTS ? "" : v)}
    disabled={disabled}
  >
    <SelectTrigger
      className={triggerClassName ?? "w-full"}
      aria-label={ariaLabel}
    >
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value={ALL_AGENTS}>All agents</SelectItem>
      {agents.map((agent) => {
        const count = overrideCounts?.[agent.id] ?? 0;
        return (
          <SelectItem key={agent.id} value={agent.id}>
            {agent.name}
            {count > 0 && (
              <span className="text-muted-foreground"> · {count}</span>
            )}
          </SelectItem>
        );
      })}
    </SelectContent>
  </Select>
);
