"use client";

import { CircleCheck, Hand, Ban } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import type { AppPermissionLevel } from "@onecli/api/apps/app-permissions";

export const permissionOptions: {
  value: AppPermissionLevel;
  label: string;
  icon: typeof CircleCheck;
}[] = [
  { value: "allow", label: "Always allow", icon: CircleCheck },
  { value: "manual_approval", label: "Needs approval", icon: Hand },
  { value: "block", label: "Block", icon: Ban },
];

interface PermissionButtonsProps {
  activePermission: AppPermissionLevel | null;
  onSelect: (permission: AppPermissionLevel) => void;
  isOptionDisabled?: (option: AppPermissionLevel) => boolean;
  covered?: boolean;
  disabled?: boolean;
}

export const PermissionButtons = ({
  activePermission,
  onSelect,
  isOptionDisabled,
  covered,
  disabled,
}: PermissionButtonsProps) => (
  <>
    {permissionOptions.map((opt) => {
      const isActive = activePermission === opt.value;
      const isBlockActive = isActive && opt.value === "block";
      const isApprovalActive = isActive && opt.value === "manual_approval";
      const optDisabled = isOptionDisabled?.(opt.value) ?? false;
      return (
        <Tooltip key={opt.value}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => onSelect(opt.value)}
              disabled={disabled || optDisabled}
              className={cn(
                "flex items-center justify-center size-8 rounded-md transition-colors",
                isBlockActive
                  ? covered
                    ? "bg-destructive/5 text-destructive/40"
                    : "bg-destructive/10 text-destructive"
                  : isApprovalActive
                    ? covered
                      ? "bg-blue-500/5 text-blue-500/40"
                      : "bg-blue-500/10 text-blue-500"
                    : isActive
                      ? covered
                        ? "bg-brand/5 text-brand/40"
                        : "bg-brand/10 text-brand"
                      : optDisabled
                        ? "text-muted-foreground/50"
                        : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50",
                (disabled || optDisabled) && "opacity-50 cursor-not-allowed",
              )}
            >
              <opt.icon className={cn("size-4", isActive && "stroke-[2.5]")} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {opt.label}
          </TooltipContent>
        </Tooltip>
      );
    })}
  </>
);
