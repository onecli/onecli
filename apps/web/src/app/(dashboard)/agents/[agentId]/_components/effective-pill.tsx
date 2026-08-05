"use client";

import { Ban, CircleCheck, CircleMinus, Globe } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
import type { CredentialAccessStatus } from "@/lib/api/policy-visibility";

// The page's effective-access pill. A span, deliberately NOT a disabled button
// (it stays in the a11y tree with its text label). The three policy-reflect
// dialogs keep their own unexported copies — extracting a shared one would put
// this step in collision with step 4's edits to those files.
const STATUS_META = {
  usable: {
    label: "Usable",
    icon: CircleCheck,
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  limited: {
    label: "Limited",
    icon: CircleMinus,
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  blocked: {
    label: "Blocked",
    icon: Ban,
    className: "bg-destructive/10 text-destructive",
  },
  unknown: {
    label: "Network only",
    icon: Globe,
    className: "bg-muted text-muted-foreground",
  },
} as const satisfies Record<
  CredentialAccessStatus,
  { label: string; icon: typeof CircleCheck; className: string }
>;

export const EffectivePill = ({
  status,
}: {
  status: CredentialAccessStatus;
}) => {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        meta.className,
      )}
    >
      <Icon className="size-3" aria-hidden />
      {meta.label}
    </span>
  );
};
