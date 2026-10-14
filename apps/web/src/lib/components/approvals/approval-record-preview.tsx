import { AlertTriangle } from "lucide-react";
import {
  CHANGE_WORDS,
  cellOpOf,
  shownValue,
  type ShownOp,
} from "@onecli/api/lib/record-change";
import { cn } from "@onecli/ui/lib/utils";
import type { ApprovalBulkChange } from "@/lib/api/approvals";
import { ApprovalLink } from "./approval-link";
import { CHANGE_COLORS } from "./change-ops";

type Op = ShownOp;

/**
 * ONE record created, changed or deleted, in the bulk table's colors. An
 * update lists each field it sets as Field · Now · New, colored by what
 * happens to it; a create marks the new record green and lists its values;
 * a delete marks the record red and lists what it holds now. Responsive:
 * three columns when there is room, each field stacked (label over values)
 * on a narrow card.
 */
export const ApprovalRecordPreview = ({
  bulk,
  className,
}: {
  bulk: ApprovalBulkChange;
  className?: string;
}) => {
  const row = bulk.rows[0];
  if (!row) return null;
  const kind = bulk.kind ?? "update";
  const read = bulk.oldValuesRead;
  const noun = bulk.objectLabel.toLowerCase();
  const recordOp: Op | null =
    kind === "delete" ? "clear" : kind === "create" ? "fill" : null;

  const fields = bulk.fields
    .map((f, i) => {
      if (kind === "delete") {
        const now = row.old?.[i];
        return now
          ? { api: f.api, label: f.label, now, next: null, op: null }
          : null;
      }
      const op = cellOpOf(row, i);
      if (op === "untouched") return null;
      return {
        api: f.api,
        label: f.label,
        now: kind === "create" ? null : (row.old?.[i] ?? null),
        next: row.new[i] ?? null,
        op: kind === "create" ? null : read ? op : null,
      };
    })
    .filter((f) => f !== null);

  const twoColumns = kind !== "update" || !read;

  return (
    <div className={cn("space-y-2 text-sm", className)}>
      <div
        data-op={recordOp ?? undefined}
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 font-semibold",
          recordOp ? CHANGE_COLORS[recordOp].cell : "bg-muted/60",
        )}
      >
        {recordOp && (
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              CHANGE_COLORS[recordOp].dot,
            )}
            aria-hidden
          />
        )}
        <span className="text-muted-foreground shrink-0 font-normal">
          {kind === "delete"
            ? `Deletes ${noun}`
            : kind === "create"
              ? `New ${noun}`
              : bulk.objectLabel}
        </span>
        <span className="min-w-0 truncate">
          <ApprovalLink href={row.url}>
            {row.name ?? (kind === "create" ? `New ${noun}` : row.id)}
          </ApprovalLink>
        </span>
      </div>

      {kind === "update" && !read && (
        <p className="text-muted-foreground text-xs" role="status">
          Its current values couldn&apos;t be read, so this shows the new values
          only.
        </p>
      )}

      {fields.length > 0 && (
        <dl className="divide-y overflow-hidden rounded-md border">
          {!twoColumns && (
            <div
              className="text-muted-foreground bg-muted/40 hidden grid-cols-[minmax(7rem,1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)] gap-x-3 px-3 py-1.5 text-xs font-medium sm:grid"
              aria-hidden
            >
              <span>Field</span>
              <span>Now</span>
              <span>New</span>
            </div>
          )}
          {fields.map((f) => (
            <div
              key={f.api}
              data-op={f.op ?? undefined}
              className={cn(
                "grid gap-x-3 gap-y-0.5 px-3 py-1.5",
                twoColumns
                  ? "grid-cols-1 sm:grid-cols-[minmax(7rem,1fr)_minmax(0,2.8fr)]"
                  : "grid-cols-1 sm:grid-cols-[minmax(7rem,1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)]",
                f.op && f.op !== "same" && CHANGE_COLORS[f.op].cell,
              )}
            >
              <dt className="text-muted-foreground flex items-center gap-1.5 text-xs sm:text-sm">
                {f.op && (
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      CHANGE_COLORS[f.op].dot,
                    )}
                    aria-hidden
                  />
                )}
                {f.label}
                {f.op && (
                  <span className="sr-only">: {CHANGE_WORDS[f.op].label}</span>
                )}
              </dt>
              {twoColumns ? (
                <dd className="min-w-0 break-words">
                  {kind === "delete" ? f.now : shownValue(f.next)}
                </dd>
              ) : (
                <>
                  <dd className="min-w-0 break-words">
                    <span className="text-muted-foreground mr-1 text-xs sm:hidden">
                      Now
                    </span>
                    <span
                      className={cn(
                        f.op === "overwrite" || f.op === "clear"
                          ? "line-through opacity-70"
                          : "text-muted-foreground",
                      )}
                    >
                      {shownValue(f.now)}
                    </span>
                  </dd>
                  <dd className="min-w-0 font-medium break-words">
                    <span className="text-muted-foreground mr-1 text-xs font-normal sm:hidden">
                      New
                    </span>
                    {f.op === "same"
                      ? "no change"
                      : f.op === "clear"
                        ? "cleared"
                        : shownValue(f.next)}
                  </dd>
                </>
              )}
            </div>
          ))}
        </dl>
      )}

      {bulk.hiddenFields?.length ? (
        <p
          className="flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-300"
          role="note"
        >
          <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>
            Also sets {bulk.hiddenFields.length} more{" "}
            {bulk.hiddenFields.length === 1 ? "field" : "fields"}:{" "}
            {bulk.hiddenFields.join(", ")}.
          </span>
        </p>
      ) : null}
    </div>
  );
};
