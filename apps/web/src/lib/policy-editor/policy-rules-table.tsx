"use client";

import { useCallback, useMemo } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type Modifier,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { LucideIcon } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";
import type { OverlapWarning } from "@onecli/api/lib/policy-overlap";
import type { PageScope, PolicyRuleV2 } from "@/lib/api";
import { DefaultRuleRow } from "./default-rule-row";
import { EditableRuleRow } from "./editable-rule-row";

const HEAD =
  "text-muted-foreground h-9 text-[11px] font-medium tracking-wide uppercase";
const COLS = 6;

// Rows only ever trade vertical positions — pin the drag to the y axis.
const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

export interface PolicyRulesTableProps {
  title: string;
  icon: LucideIcon;
  description?: string;
  rules: PolicyRuleV2[];
  /** The whole section is editable (custom rows get controls) or read-only. */
  editable: boolean;
  identityName: (id: string) => string;
  emptyLabel: string;
  /** The scope's terminal Default Rule, rendered as the section's last row. */
  defaultRule: PolicyRuleV2 | null;
  scope: PageScope;
  /** Staged-change chips per rule (logicalId → "new" | "changed"). */
  diffState?: ReadonlyMap<string, "new" | "changed">;
  /** Provably-dead-rule chips (logicalId → the overlap warning). */
  overlapState?: ReadonlyMap<string, OverlapWarning>;
  /** The Default Rule's action differs from the published one. */
  defaultChanged?: boolean;
  /** Commit a new CUSTOM relative order (drag drop / Move up-down). Absent on
   * read-only sections. */
  onReorder?: (newCustomOrder: string[]) => void;
  /** Reordering is locked — an in-flight reorder, a refetch, or an active
   * search filter (a filtered list is not the true order). */
  reorderLocked?: boolean;
  onEdit: (rule: PolicyRuleV2) => void;
  onToggleEnabled: (rule: PolicyRuleV2) => void;
  onDelete: (rule: PolicyRuleV2) => void;
}

/**
 * One policy layer as a section: a titled band, its own column header, the rule
 * rows, and the terminal Default Rule as the last row. The editor stacks these
 * inside a single bordered card (org guardrails, then project rules) so the two
 * layers read as one top-to-bottom evaluation rather than two islands.
 *
 * Custom rows drag to reorder (grip = the handle; keyboard: focus it, Space to
 * lift, arrows to move, Space to drop). System-derived rows and the Default row
 * are fixed landmarks — a drop is relative to the other CUSTOM rules only, and
 * the system rows keep their positions.
 */
export const PolicyRulesTable = ({
  title,
  icon: Icon,
  description,
  rules,
  editable,
  identityName,
  emptyLabel,
  defaultRule,
  scope,
  diffState,
  overlapState,
  defaultChanged = false,
  onReorder,
  reorderLocked = false,
  onEdit,
  onToggleEnabled,
  onDelete,
}: PolicyRulesTableProps) => {
  const sortColumn = editable && !!onReorder;

  const sensors = useSensors(
    // A small activation distance keeps plain clicks (kebab, name) working.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // The custom rules in visible order — the only rows a reorder can move.
  const customIds = useMemo(
    () => rules.filter((r) => r.source === "custom").map((r) => r.id),
    [rules],
  );

  // Screen-reader narration by rule NAME and list position — the dnd-kit
  // defaults would read the raw row ids.
  const announcements = useMemo<Announcements>(() => {
    const nameOf = (id: UniqueIdentifier) =>
      rules.find((r) => r.id === id)?.name ?? "the rule";
    const positionOf = (id: UniqueIdentifier) =>
      rules.findIndex((r) => r.id === id) + 1;
    return {
      onDragStart: ({ active }) =>
        `Picked up ${nameOf(active.id)}. Use the arrow keys to move it, space to drop, escape to cancel.`,
      onDragOver: ({ active, over }) =>
        over
          ? `${nameOf(active.id)} is over position ${positionOf(over.id)} of ${rules.length}.`
          : `${nameOf(active.id)} is no longer over a row.`,
      onDragEnd: ({ active, over }) =>
        over
          ? `${nameOf(active.id)} dropped at position ${positionOf(over.id)} of ${rules.length}.`
          : `${nameOf(active.id)} dropped.`,
      onDragCancel: ({ active }) =>
        `Reordering cancelled. ${nameOf(active.id)} returned to its original position.`,
    };
  }, [rules]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      // A drag that STARTED unlocked can end after the lock flipped (e.g. the
      // filter was typed mid-keyboard-drag) — drop it rather than commit an
      // order derived from a list that no longer matches the draft.
      if (!onReorder || reorderLocked || !over || active.id === over.id) return;
      const from = rules.findIndex((r) => r.id === active.id);
      const to = rules.findIndex((r) => r.id === over.id);
      if (from < 0 || to < 0) return;
      // Move within the visible list, then keep only the customs' relative
      // order — system rows re-slot server-side, never by a drag.
      const moved = arrayMove(rules, from, to);
      onReorder(moved.filter((r) => r.source === "custom").map((r) => r.id));
    },
    [rules, onReorder, reorderLocked],
  );

  const moveCustom = useCallback(
    (id: string, delta: -1 | 1) => {
      if (!onReorder) return;
      const idx = customIds.indexOf(id);
      const target = idx + delta;
      if (idx < 0 || target < 0 || target >= customIds.length) return;
      onReorder(arrayMove(customIds, idx, target));
    },
    [customIds, onReorder],
  );

  return (
    <section className="bg-card overflow-hidden rounded-xl border">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3">
        <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && (
          <p className="text-muted-foreground w-full text-xs sm:ml-1 sm:w-auto">
            {description}
          </p>
        )}
      </div>

      <div className="overflow-x-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          accessibility={{ announcements }}
          onDragEnd={handleDragEnd}
        >
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className={`${HEAD} w-[72px] pl-4`}>
                  Priority
                </TableHead>
                <TableHead scope="col" className={`${HEAD} w-[240px]`}>
                  Name
                </TableHead>
                <TableHead scope="col" className={`${HEAD} w-[150px]`}>
                  Applies to
                </TableHead>
                <TableHead scope="col" className={HEAD}>
                  Target
                </TableHead>
                <TableHead scope="col" className={`${HEAD} w-[170px]`}>
                  Action
                </TableHead>
                <TableHead scope="col" className={`${HEAD} w-[52px] pr-3`}>
                  <span className="sr-only">Row actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <SortableContext
                items={rules.map((r) => r.id)}
                strategy={verticalListSortingStrategy}
              >
                {rules.map((rule, i) => {
                  const customIdx = customIds.indexOf(rule.id);
                  const sortable = sortColumn && rule.source === "custom";
                  return (
                    <EditableRuleRow
                      key={rule.id}
                      rule={rule}
                      position={i + 1}
                      identityName={identityName}
                      editable={editable && rule.source === "custom"}
                      sortColumn={sortColumn}
                      sortable={sortable}
                      sortLocked={reorderLocked}
                      onMoveUp={
                        sortable && customIdx > 0
                          ? () => moveCustom(rule.id, -1)
                          : undefined
                      }
                      onMoveDown={
                        sortable && customIdx < customIds.length - 1
                          ? () => moveCustom(rule.id, 1)
                          : undefined
                      }
                      changeState={diffState?.get(rule.logicalId)}
                      overlap={overlapState?.get(rule.logicalId)}
                      onEdit={onEdit}
                      onToggleEnabled={onToggleEnabled}
                      onDelete={onDelete}
                    />
                  );
                })}
              </SortableContext>
              {rules.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={COLS}
                    className="text-muted-foreground py-9 text-center text-sm"
                  >
                    {emptyLabel}
                  </TableCell>
                </TableRow>
              )}
              {defaultRule && (
                <DefaultRuleRow
                  scope={scope}
                  rule={defaultRule}
                  editable={editable}
                  changed={defaultChanged}
                />
              )}
            </TableBody>
          </Table>
        </DndContext>
      </div>
    </section>
  );
};
