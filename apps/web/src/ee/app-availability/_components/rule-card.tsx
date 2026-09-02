"use client";

import { X } from "lucide-react";
import { Input } from "@onecli/ui/components/input";
import { IdentityMultiSelect } from "./identity-multi-select";
import { AppMultiSelect } from "./app-multi-select";

/** One availability rule in edit form. `key` is client-stable for React; `id` is
 *  the server id (present for existing rules, absent for newly-added ones). */
export interface RuleDraft {
  key: string;
  id?: string;
  name: string;
  userIds: string[];
  groupIds: string[];
  providers: string[];
}

export interface RuleCardProps {
  rule: RuleDraft;
  onChange: (patch: Partial<RuleDraft>) => void;
  onRemove: () => void;
  disabled?: boolean;
}

const LABEL =
  "text-muted-foreground text-[11px] font-medium tracking-wide uppercase";

/** A single named rule: who it applies to (users + groups) → which apps. */
export const RuleCard = ({
  rule,
  onChange,
  onRemove,
  disabled,
}: RuleCardProps) => (
  <div className="rounded-lg border">
    <div className="flex items-center gap-1 border-b px-3 py-2">
      {/* Ghost title — reads as the rule's name, not a form box; the muted
          placeholder is all that shows when empty (name is optional). */}
      <Input
        value={rule.name}
        onChange={(e) => onChange({ name: e.target.value })}
        placeholder="Rule name (optional)"
        disabled={disabled}
        aria-label="Rule name"
        className="hover:bg-muted/50 -ml-2 h-8 flex-1 rounded-md border-0 bg-transparent px-2 text-sm font-medium shadow-none dark:bg-transparent"
      />
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label="Remove rule"
        className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-50"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
    <div className="space-y-4 p-3">
      <div className="space-y-1.5">
        <span className={LABEL}>People</span>
        <IdentityMultiSelect
          userIds={rule.userIds}
          groupIds={rule.groupIds}
          onChange={(userIds, groupIds) => onChange({ userIds, groupIds })}
          disabled={disabled}
        />
      </div>
      <div className="space-y-1.5">
        <span className={LABEL}>Apps</span>
        <div>
          <AppMultiSelect
            value={rule.providers}
            onChange={(providers) => onChange({ providers })}
            disabled={disabled}
            label={rule.name.trim() || "this rule"}
          />
        </div>
      </div>
    </div>
  </div>
);
