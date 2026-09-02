"use client";

import { Badge } from "@onecli/ui/components/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { cn } from "@onecli/ui/lib/utils";
import type {
  EffectiveToolResult,
  OrgCeilingVerdict,
} from "@/lib/api/policy-visibility";
import { TriStateControl, type ToolChoice } from "./tri-state-control";

interface PermissionToolRowProps {
  tool: { id: string; name: string; description: string };
  choice: ToolChoice;
  ceiling: OrgCeilingVerdict | null;
  /** The combined effective verdict (rate-limit display stays a read-only
   * reflection here — modifiers are org/policy business). */
  effective: EffectiveToolResult | undefined;
  readOnly: boolean;
  askLocked: boolean;
  onSelect: (choice: ToolChoice) => void;
}

export const PermissionToolRow = ({
  tool,
  choice,
  ceiling,
  effective,
  readOnly,
  askLocked,
  onSelect,
}: PermissionToolRowProps) => {
  const orgBlocked = ceiling === "block";
  const orgFloorsApproval = ceiling === "approval";

  const isOptionDisabled = (value: ToolChoice) => {
    if (orgBlocked) {
      return { disabled: true, why: "Blocked by your organization" };
    }
    if (orgFloorsApproval && value === "allow") {
      return { disabled: true, why: "Org minimum: needs approval" };
    }
    return { disabled: false };
  };

  // The control shows the EFFECTIVE state, never a choice the org overrides:
  // an org block pins Never; an org approval floor lifts a looser "allow" to
  // Needs-approval (blue). Display-only — the stored choice is untouched, so
  // if the org later relaxes its rule the workspace's own intent resumes.
  const displayedChoice: ToolChoice = orgBlocked
    ? "never"
    : orgFloorsApproval && choice === "allow"
      ? "ask"
      : choice;

  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={cn("text-sm", orgBlocked && "text-muted-foreground")}
          >
            {tool.name}
          </span>
          {orgBlocked && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="text-[10px] font-normal">
                  Organization
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="top">
                Blocked by your organization
              </TooltipContent>
            </Tooltip>
          )}
          {effective?.rateLimit != null && (
            <span className="text-muted-foreground bg-muted rounded px-1.5 py-0.5 text-[10px]">
              {effective.rateLimit}/{effective.rateLimitWindow}
            </span>
          )}
        </div>
        {/* Wraps rather than truncates: the description is the decision
            support for a security choice, so it must be fully readable -
            an ellipsis with no affordance to reveal the rest is not.
            `break-words` guards long unbroken tokens (host names). */}
        <p className="text-muted-foreground mt-0.5 break-words text-xs">
          {orgFloorsApproval ? "Org minimum: needs approval" : tool.description}
        </p>
      </div>
      {/* Top-aligned so a wrapped description grows downward while the
          control stays anchored beside the title; -mt-1.5 optically centers
          the 32px control on the ~20px title line. */}
      <div className="-mt-1.5 shrink-0">
        <TriStateControl
          value={displayedChoice}
          onSelect={onSelect}
          isOptionDisabled={isOptionDisabled}
          disabled={readOnly}
          askLocked={askLocked}
        />
      </div>
    </div>
  );
};
