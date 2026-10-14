"use client";

import { memo, useId, useState } from "react";
import { AlertTriangle } from "lucide-react";

import {
  CHANGE_WORDS,
  cellOpOf,
  changeCounts,
  pluralLabel,
  shownValue,
  type ShownOp,
} from "@onecli/api/lib/record-change";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import type { ApprovalBulkChange, ApprovalBulkRow } from "@/lib/api/approvals";
import { ApprovalLink } from "./approval-link";
import { CHANGE_COLORS } from "./change-ops";

/** Rows a collapsed table fits before it scrolls (like Slack's CSV
 *  preview); Expand makes the box taller, it still scrolls inside. */
const COLLAPSED_ROWS = 6;

const RecordName = ({ row }: { row: ApprovalBulkRow }) => (
  <ApprovalLink href={row.url}>{row.name ?? row.id}</ApprovalLink>
);

/**
 * One approval for a whole list of records. The legend counts each kind of
 * change (red clears, blue updates, green fills, gray no change); the
 * table colors every cell by what will happen to it, the riskiest rows
 * first. The reviewer skims rather than checks each row.
 *
 * Memoized: the card around it re-renders every second for its countdown,
 * and this table can hold 200 rows by 40 fields; `bulk` keeps its identity
 * between polls (React Query's structural sharing), so it renders once.
 */
export const ApprovalBulkPreview = memo(
  ({ bulk, className }: { bulk: ApprovalBulkChange; className?: string }) => {
    const [expanded, setExpanded] = useState(false);
    const tableId = useId();
    const total = bulk.rows.length;
    const kind = bulk.kind ?? "update";
    // Who each record is (account, title): plain gray text after the name,
    // so the change columns stay the colored ones.
    const context = bulk.context ?? [];
    // A create's values are all new (green); a delete's are all lost (red),
    // so neither depends on a read to color them.
    const read = kind === "create" ? true : bulk.oldValuesRead;
    const noun = bulk.objectLabel.toLowerCase();
    const legend: { op: ShownOp; label: string; n: number }[] =
      kind === "delete"
        ? [{ op: "clear", label: "Deletes", n: total }]
        : kind === "create"
          ? [{ op: "fill", label: "Creates", n: total }]
          : changeCounts(bulk.rows).map(({ op, n }) => ({
              op,
              label: CHANGE_WORDS[op].label,
              n,
            }));

    return (
      <div className={cn("space-y-2 text-sm", className)}>
        <p className="font-medium">
          {total} {pluralLabel(noun, total)}
          {kind === "delete"
            ? " will be deleted"
            : bulk.fields.length > 4
              ? ` · ${bulk.fields.length + (bulk.hiddenFields?.length ?? 0)} fields`
              : `: ${bulk.fields.map((f) => f.label).join(", ")}`}
        </p>
        {read || kind === "delete" ? (
          <ul
            className="flex flex-wrap gap-x-4 gap-y-1"
            aria-label="Changes by kind"
          >
            {legend.map(({ op, label, n }) => (
              <li key={op} className="flex items-center gap-1.5">
                <span
                  className={cn("size-2.5 rounded-full", CHANGE_COLORS[op].dot)}
                  aria-hidden
                />
                <span>
                  {label} <span className="tabular-nums">{n}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {read ? null : (
          <p className="text-muted-foreground" role="status">
            {kind === "delete"
              ? "Their current values couldn't be read, so the table names the records only."
              : "Current values couldn't be read, so this shows new values only."}
          </p>
        )}
        {bulk.hiddenFields?.length ? (
          <p
            className="flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-300"
            role="note"
          >
            <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
            <span>
              The table shows {bulk.fields.length} of{" "}
              {bulk.fields.length + bulk.hiddenFields.length} fields. Also set,
              not shown: {bulk.hiddenFields.join(", ")}.
            </span>
          </p>
        ) : null}
        <div
          id={tableId}
          role="region"
          aria-label={`${total} ${pluralLabel(noun, total)}: changes`}
          tabIndex={0}
          className={cn(
            // `relative`: the cells' sr-only labels are absolutely
            // positioned; without a positioned scroller they escape its
            // clip and widen the page on a phone.
            "relative overflow-auto rounded-md border bg-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            expanded ? "max-h-[28rem]" : "max-h-56",
          )}
        >
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-muted">
              <tr>
                <th className="w-8 border-b px-2 py-1.5 text-right font-normal text-muted-foreground">
                  #
                </th>
                <th className="border-b px-2 py-1.5 text-left font-medium">
                  {bulk.objectLabel}
                </th>
                {context.map((c) => (
                  <th
                    key={c.api}
                    className="border-b px-2 py-1.5 text-left font-normal text-muted-foreground"
                  >
                    {c.label}
                  </th>
                ))}
                {bulk.fields.map((f) => (
                  <th
                    key={f.api}
                    className="border-b border-l px-2 py-1.5 text-left font-medium"
                  >
                    {f.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bulk.rows.map((row, n) => (
                <tr
                  key={row.id}
                  data-op={row.op}
                  className="border-b last:border-0"
                >
                  <td className="px-2 py-1 text-right text-muted-foreground tabular-nums">
                    {n + 1}
                  </td>
                  <td
                    data-op={
                      kind === "delete"
                        ? "clear"
                        : kind === "create"
                          ? "fill"
                          : undefined
                    }
                    className={cn(
                      "max-w-48 truncate px-2 py-1 font-semibold",
                      kind === "delete" && CHANGE_COLORS.clear.cell,
                      kind === "create" && CHANGE_COLORS.fill.cell,
                    )}
                    title={row.name ?? row.id}
                  >
                    {kind !== "update" && (
                      <span className="sr-only">
                        {kind === "delete" ? "Deleted: " : "New: "}
                      </span>
                    )}
                    {kind === "create" && !row.name ? (
                      <span className="font-normal">New {noun}</span>
                    ) : (
                      <RecordName row={row} />
                    )}
                  </td>
                  {context.map((c, i) => (
                    <td
                      key={c.api}
                      className="max-w-40 truncate px-2 py-1 text-muted-foreground"
                      title={row.context?.[i] ?? undefined}
                    >
                      {row.context?.[i] ?? ""}
                    </td>
                  ))}
                  {bulk.fields.map((f, i) => {
                    // A whole record is created or deleted: the name cell
                    // carries the color, its values stay plain.
                    if (kind === "delete" || kind === "create") {
                      const v = kind === "delete" ? row.old?.[i] : row.new[i];
                      return (
                        <td
                          key={f.api}
                          className="border-l px-2 py-1 whitespace-nowrap"
                        >
                          {v ?? ""}
                        </td>
                      );
                    }
                    const op = cellOpOf(row, i);
                    if (op === "untouched") {
                      return (
                        <td
                          key={f.api}
                          className="border-l px-2 py-1 text-muted-foreground"
                        >
                          not changed
                        </td>
                      );
                    }
                    return (
                      <td
                        key={f.api}
                        data-op={op}
                        className={cn(
                          "border-l px-2 py-1 whitespace-nowrap",
                          read && CHANGE_COLORS[op].cell,
                        )}
                      >
                        <span className="sr-only">
                          {CHANGE_WORDS[op].label}:{" "}
                        </span>
                        {read && (op === "overwrite" || op === "clear") && (
                          <span className="line-through opacity-70">
                            {shownValue(row.old?.[i])}
                          </span>
                        )}
                        {read &&
                          (op === "overwrite" || op === "clear") &&
                          " → "}
                        <span>
                          {op === "clear" ? "cleared" : shownValue(row.new[i])}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {total > COLLAPSED_ROWS && (
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={expanded}
            aria-controls={tableId}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Collapse" : `Expand (${total} rows)`}
          </Button>
        )}
      </div>
    );
  },
);
ApprovalBulkPreview.displayName = "ApprovalBulkPreview";
