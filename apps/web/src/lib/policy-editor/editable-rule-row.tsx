"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowUp,
  Ban,
  Check,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { TableCell, TableRow } from "@onecli/ui/components/table";
import { cn } from "@onecli/ui/lib/utils";
import type { OverlapWarning } from "@onecli/api/lib/policy-overlap";
import type { PolicyRuleSource, PolicyRuleV2 } from "@/lib/api";
import { ActionVerdict } from "./policy-preview/policy-action-verdict";
import { IdentityCell } from "./policy-preview/policy-identity-cell";
import { TargetCell } from "./policy-preview/policy-target-cell";

const SOURCE_LABEL: Partial<Record<PolicyRuleSource, string>> = {
  app_permission: "App Permissions",
  blocklist: "Blocklist",
};

export interface EditableRuleRowProps {
  rule: PolicyRuleV2;
  /** 1-based position within the section. */
  position: number;
  identityName: (id: string) => string;
  /** Custom rules in the editing scope are editable; derived + org rows aren't. */
  editable: boolean;
  /** The section supports reordering — reserves the grip gutter on every row. */
  sortColumn?: boolean;
  /** This row is draggable (a custom rule in a reorderable section). */
  sortable?: boolean;
  /** Reordering is locked (in-flight reorder, refetch, or an active filter). */
  sortLocked?: boolean;
  /** Move one step within the custom relative order; undefined = at the bound. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** Staged-change chip: this rule is new or edited since the last Apply. */
  changeState?: "new" | "changed";
  /** Provably-dead chip: this rule can never take effect (see policy-overlap). */
  overlap?: OverlapWarning;
  onEdit: (rule: PolicyRuleV2) => void;
  onToggleEnabled: (rule: PolicyRuleV2) => void;
  onDelete: (rule: PolicyRuleV2) => void;
}

/**
 * One rule row — always on the card's plain background. Custom rules in the
 * editing scope (including the former App Permissions rules, adopted as customs
 * at the editing cutover) get a drag grip (reorder), a name button (opens the
 * drawer) + a kebab (Edit / Move up / Move down / Enable-disable / Delete);
 * derived rules (blocklist, plus any mid-deploy app_permission straggler
 * awaiting adoption) and org guardrails render read-only with a provenance
 * badge and hold their position. A disabled rule keeps its row but wears a
 * "Disabled" tag and reads muted.
 */
export const EditableRuleRow = ({
  rule,
  position,
  identityName,
  editable,
  sortColumn = false,
  sortable = false,
  sortLocked = false,
  onMoveUp,
  onMoveDown,
  changeState,
  overlap,
  onEdit,
  onToggleEnabled,
  onDelete,
}: EditableRuleRowProps) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: rule.id, disabled: !sortable || sortLocked });

  const sourceLabel = SOURCE_LABEL[rule.source];
  const muted = !rule.enabled;
  return (
    <TableRow
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        editable && "hover:bg-muted/40",
        // The lifted row reads raised via background alone — box-shadow doesn't
        // paint on a <tr> under the table's collapsed borders.
        isDragging && "bg-muted relative z-10",
      )}
    >
      <TableCell className="text-muted-foreground pl-4 text-xs tabular-nums">
        <div className="flex items-center gap-1">
          {sortable ? (
            <button
              type="button"
              ref={setActivatorNodeRef}
              {...attributes}
              {...listeners}
              disabled={sortLocked}
              aria-label={`Reorder ${rule.name}`}
              title={
                sortLocked
                  ? "Reordering is unavailable while filtering or saving"
                  : "Drag to reorder"
              }
              className={cn(
                "text-muted-foreground/70 hover:text-foreground hover:bg-muted focus-visible:ring-ring -ml-1.5 flex size-6 shrink-0 touch-none items-center justify-center rounded outline-none focus-visible:ring-2",
                isDragging ? "cursor-grabbing" : "cursor-grab",
                sortLocked &&
                  "hover:text-muted-foreground/70 cursor-default opacity-40 hover:bg-transparent",
              )}
            >
              <GripVertical className="size-3.5" aria-hidden />
            </button>
          ) : (
            sortColumn && (
              <span className="-ml-1.5 size-6 shrink-0" aria-hidden />
            )
          )}
          <span>{position}</span>
        </div>
      </TableCell>
      <TableCell className={cn(muted && "opacity-60")}>
        <div className="flex min-w-0 flex-col gap-0.5">
          {editable ? (
            <button
              type="button"
              onClick={() => onEdit(rule)}
              className="focus-visible:ring-ring -mx-1 max-w-full rounded-sm px-1 text-left text-sm font-medium outline-none focus-visible:ring-2"
            >
              <span className="block truncate">{rule.name}</span>
            </button>
          ) : (
            <span className="block truncate text-sm font-medium">
              {rule.name}
            </span>
          )}
          {(sourceLabel || muted || changeState || overlap) && (
            <div className="flex items-center gap-1.5">
              {overlap && (
                <Badge
                  variant="outline"
                  title={
                    overlap.kind === "shadowed"
                      ? `Never reached — “${overlap.byName}” above already matches everything this rule matches.`
                      : overlap.kind === "conflict"
                        ? `Identical to “${overlap.byName}” above with a different action — this rule's verdict never applies.`
                        : `Identical to “${overlap.byName}” above — this rule is redundant.`
                  }
                  className={
                    overlap.kind === "conflict"
                      ? "border-destructive/40 text-destructive rounded px-1.5 py-0 text-[10px] font-medium"
                      : overlap.kind === "shadowed"
                        ? "rounded border-amber-500/40 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:text-amber-400"
                        : "text-muted-foreground rounded px-1.5 py-0 text-[10px] font-medium"
                  }
                >
                  {overlap.kind === "shadowed"
                    ? "Unreachable"
                    : overlap.kind === "conflict"
                      ? "Conflicts"
                      : "Duplicate"}
                </Badge>
              )}
              {changeState && (
                <Badge
                  variant="outline"
                  className={
                    changeState === "new"
                      ? "rounded border-emerald-500/40 px-1.5 py-0 text-[10px] font-medium text-emerald-700 dark:text-emerald-400"
                      : "rounded border-amber-500/40 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:text-amber-400"
                  }
                >
                  {changeState === "new" ? "New" : "Changed"}
                </Badge>
              )}
              {sourceLabel && (
                <Badge
                  variant="secondary"
                  className="text-muted-foreground rounded px-1.5 py-0 text-[10px] font-normal"
                >
                  {sourceLabel}
                </Badge>
              )}
              {muted && (
                <span className="text-muted-foreground text-[10px] tracking-wide uppercase">
                  Disabled
                </span>
              )}
            </div>
          )}
        </div>
      </TableCell>
      <TableCell className={cn(muted && "opacity-60")}>
        <IdentityCell rule={rule} identityName={identityName} />
      </TableCell>
      <TableCell className={cn(muted && "opacity-60")}>
        <TargetCell targets={rule.targets} />
      </TableCell>
      <TableCell className={cn(muted && "opacity-60")}>
        <ActionVerdict rule={rule} />
      </TableCell>
      <TableCell className="pr-3 text-right">
        {editable && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground size-8"
                aria-label={`Actions for ${rule.name}`}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => onEdit(rule)}>
                <Pencil className="size-4" />
                Edit
              </DropdownMenuItem>
              {sortable && (
                <>
                  <DropdownMenuItem
                    disabled={!onMoveUp || sortLocked}
                    onClick={onMoveUp}
                  >
                    <ArrowUp className="size-4" />
                    Move up
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!onMoveDown || sortLocked}
                    onClick={onMoveDown}
                  >
                    <ArrowDown className="size-4" />
                    Move down
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuItem onClick={() => onToggleEnabled(rule)}>
                {rule.enabled ? (
                  <>
                    <Ban className="size-4" />
                    Disable
                  </>
                ) : (
                  <>
                    <Check className="size-4" />
                    Enable
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onDelete(rule)}
              >
                <Trash2 className="size-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </TableCell>
    </TableRow>
  );
};
