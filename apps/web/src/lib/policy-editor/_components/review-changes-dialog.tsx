"use client";

import { TriangleAlert } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { cn } from "@onecli/ui/lib/utils";
import type { PolicyDiff, RuleChange } from "@onecli/api/lib/policy-diff";

export interface ReviewChangesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  diff: PolicyDiff;
  /** Workspace scope gets the allowlist warning when the default flips to Block. */
  isWorkspace: boolean;
  applying: boolean;
  onApply: () => void;
}

/**
 * The review-before-apply summary: exactly what will change when the staged
 * draft is published, grouped Added / Changed / Removed / Default Rule, with a
 * consequence warning for the one high-impact case (a workspace default flipping
 * to Block = the workspace becomes an allowlist). Data comes from the React Query
 * cache — the diff was already computed for the header count.
 */
export const ReviewChangesDialog = ({
  open,
  onOpenChange,
  diff,
  isWorkspace,
  applying,
  onApply,
}: ReviewChangesDialogProps) => {
  const plural = diff.count === 1 ? "change" : "changes";
  return (
    <Dialog
      open={open}
      // No closing mid-apply (Escape / outside-click / the X all route here) —
      // the loading context must stay visible until the mutation settles.
      onOpenChange={(next) => {
        if (!applying) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Review changes</DialogTitle>
          <DialogDescription>
            {diff.count} {plural} will be enforced immediately after you apply.
          </DialogDescription>
        </DialogHeader>

        <div
          className="flex max-h-[50vh] flex-col gap-4 overflow-y-auto"
          tabIndex={0}
          role="region"
          aria-label="Changes to apply"
        >
          <ChangeGroup label="Added" tone="emerald" items={diff.added}>
            {(c) => <ActionLabel action={c.action} />}
          </ChangeGroup>
          <ChangeGroup label="Changed" tone="amber" items={diff.changed}>
            {(c) => (
              <span className="text-muted-foreground text-xs">
                {c.details.join(" · ")}
              </span>
            )}
          </ChangeGroup>
          <ChangeGroup label="Removed" tone="destructive" items={diff.removed}>
            {() => (
              <span className="text-muted-foreground text-xs">
                will no longer apply
              </span>
            )}
          </ChangeGroup>

          {diff.reordered && (
            <div>
              <GroupHeading label="Reordered" tone="amber" />
              <p className="text-muted-foreground py-1 text-xs">
                The evaluation order of the rules changed.
              </p>
            </div>
          )}

          {diff.defaultChange && (
            <div>
              <GroupHeading label="Default Rule" tone="amber" />
              <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                <span>Default action</span>
                <span className="text-muted-foreground text-xs">
                  <ActionLabel action={diff.defaultChange.from} /> →{" "}
                  <ActionLabel action={diff.defaultChange.to} />
                </span>
              </div>
            </div>
          )}

          {isWorkspace && diff.defaultChange?.to === "block" && (
            <div className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
              <TriangleAlert
                className="size-4 shrink-0 text-amber-700 dark:text-amber-400"
                aria-hidden
              />
              <p>
                <span className="font-semibold">
                  This workspace becomes an allowlist.
                </span>{" "}
                With the Default Rule set to Block, only requests matching a
                workspace allow rule will pass.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={applying}
          >
            Cancel
          </Button>
          <Button
            loading={applying}
            // A stale-open dialog can reach 0 (e.g. a publish from another tab
            // refetched underneath) — don't offer a no-op generation.
            disabled={diff.count === 0}
            onClick={onApply}
          >
            {applying ? "Applying…" : `Apply ${diff.count} ${plural}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const TONE = {
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  destructive: "bg-destructive",
} as const;

const GroupHeading = ({
  label,
  tone,
  count,
}: {
  label: string;
  tone: keyof typeof TONE;
  count?: number;
}) => (
  <p className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase">
    <span
      className={cn("inline-block size-1.5 rounded-full", TONE[tone])}
      aria-hidden
    />
    {label}
    {count !== undefined && ` · ${count}`}
  </p>
);

const ChangeGroup = ({
  label,
  tone,
  items,
  children,
}: {
  label: string;
  tone: keyof typeof TONE;
  items: RuleChange[];
  children: (c: RuleChange) => React.ReactNode;
}) => {
  if (items.length === 0) return null;
  return (
    <div>
      <GroupHeading label={label} tone={tone} count={items.length} />
      <ul className="divide-y divide-dashed">
        {items.map((c) => (
          <li
            key={c.logicalId}
            className="flex items-baseline justify-between gap-3 py-1.5 text-sm"
          >
            <span
              className={cn(
                "min-w-0 truncate",
                tone === "destructive" && "text-muted-foreground line-through",
              )}
            >
              {c.name}
            </span>
            <span className="shrink-0">{children(c)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

const ActionLabel = ({ action }: { action: "allow" | "block" }) => (
  <span
    className={cn(
      "text-xs font-medium",
      action === "allow"
        ? "text-emerald-700 dark:text-emerald-400"
        : "text-destructive",
    )}
  >
    {action === "allow" ? "Allow" : "Block"}
  </span>
);
