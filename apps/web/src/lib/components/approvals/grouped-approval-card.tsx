"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import {
  batchArrival,
  batchArrivalNote,
  isOddOneOut,
  orderGroupRows,
  recordNounOf,
  summarizeChanges,
  type ApprovalGroup,
} from "@onecli/api/lib/approval-groups";
import { mergeBatchTables } from "@onecli/api/lib/batch-table";
import { bulkTitle } from "@onecli/api/lib/record-change";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import { useDecideApprovals } from "@/hooks/use-approvals";
import type {
  ApprovalDecisionInput,
  GroupedOutcome,
  PendingApproval,
} from "@/lib/api/approvals";
import type { ApprovalResult } from "@/lib/api/approval-outcomes";
import { ApprovalAppIcon } from "./approval-app-icon";
import { ApprovalBulkPreview } from "./approval-bulk-preview";
import { ApprovalChangeSummary, NAMES_SHOWN } from "./approval-change-summary";
import { ApprovalDetailsDialog } from "./approval-details-dialog";
import { shareOneRecord, subjectRow } from "./approval-rows";
import { ApprovalTitle } from "./approval-title";
import { GroupedApprovalRow, groupRowFields } from "./grouped-approval-row";
import { formatCountdown, secondsUntil, useNow } from "./use-countdown";

/** Rows shown before "Show all" on a long batch. A batch of up to
 *  `OPEN_ROWS` shows every row at once, so Approve all is one click: a
 *  reviewer is never asked to approve rows they haven't seen, and a
 *  20-record task fits on screen. */
const COLLAPSED_ROWS = 5;
const OPEN_ROWS = 25;

/** A member decided already, kept on the card with its outcome. */
export interface SettledMember {
  approval: PendingApproval;
  outcome: GroupedOutcome;
  /** Where a person decided it (`slack`, `web`), when known. */
  via?: string;
  /** What an approved request actually did upstream, when known. */
  result?: ApprovalResult;
}

/** A colour per kind of change, so the sections of one stacked card read as
 *  different tasks at a glance: creates green, updates blue, deletes red. */
const actionTone = (action: string): { dot: string; pill: string } => {
  const verb = action.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (/^(create|add|insert|new|upload)$/.test(verb)) {
    return {
      dot: "bg-emerald-500",
      pill: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    };
  }
  if (/^(update|edit|modify|change|patch|rename|upsert)$/.test(verb)) {
    return {
      dot: "bg-sky-500",
      pill: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
    };
  }
  if (/^(delete|remove|archive|cancel)$/.test(verb)) {
    return {
      dot: "bg-red-500",
      pill: "bg-red-500/10 text-red-700 dark:text-red-400",
    };
  }
  return { dot: "bg-muted-foreground", pill: "bg-muted text-foreground" };
};

/**
 * One card for a task's held requests, the answer to "approve 39 contacts
 * one by one": every request is listed (odd actions pinned first and
 * flagged), each decidable on its own, plus Approve all / Deny all over
 * EXACTLY the rows on screen at the click. Rows that arrive later join as
 * new, undecided rows.
 *
 * The title is always what the gateway read from the requests ("Create
 * Contact in Account Acme"); the agent's batch label and count are its own
 * claim, shown as that. Enter / Esc approve / deny all, only while the card
 * itself has focus, and never in the bell (where Esc closes the popover).
 */
export const GroupedApprovalCard = ({
  group,
  settled = [],
  showAgent = false,
  compact = false,
  section = false,
}: {
  group: ApprovalGroup<PendingApproval>;
  /** Members already decided: kept on the card, disabled, each showing the
   *  decision made. Never part of Approve all. */
  settled?: SettledMember[];
  /** The bell lists every agent's approvals; the chat thread is one agent's. */
  showAgent?: boolean;
  /** Bell density: no row list until expanded, no keyboard shortcuts. */
  compact?: boolean;
  /** Rendered as one section of a stacked card (no frame of its own). */
  section?: boolean;
}) => {
  const decide = useDecideApprovals();
  const [expanded, setExpanded] = useState(false);
  // "Show each request": the summary's per-request view, opened on demand.
  const [eachShown, setEachShown] = useState(false);
  const [details, setDetails] = useState<PendingApproval | null>(null);
  // One clock for the countdown and the batch hold.
  const now = useNow();
  // A row decided here keeps its outcome until the thread's own settled
  // record catches up: the pending list drops a decided id at once, so the
  // row's approval is snapshotted too, or it would vanish from the card.
  const [local, setLocal] = useState<Record<string, SettledMember>>({});
  // A batch of record lists (one task split by field set: 6 x industry,
  // 1 x employees, 2 x both) reads as the ONE table it is, by the same rule
  // Slack uses (`mergeBatchTables`). Its per-request titles name their own
  // counts, so the action grouping would otherwise flag rows as odd ones
  // out that are the same change. Memoized on the group: the card's own
  // countdown re-renders it every second, and must not rebuild (and so
  // re-render) a table of up to 200 x 40 cells each time.
  const mergedTable = useMemo(
    () => mergeBatchTables(group.approvals),
    [group.approvals],
  );
  const remaining = secondsUntil(
    group.expiresAt ? new Date(group.expiresAt).toISOString() : "",
    now,
  );
  const urgent = remaining <= 30;
  const busy = decide.isPending;

  const outcomeOf = new Map<string, SettledMember>();
  const rowById = new Map(group.approvals.map((a) => [a.id, a]));
  for (const s of [...Object.values(local), ...settled]) {
    outcomeOf.set(s.approval.id, s);
    if (!rowById.has(s.approval.id)) rowById.set(s.approval.id, s.approval);
  }
  // Odd actions first (a delete among creates can't hide), then by the
  // record's name ("Test01 … Test20"), the same order Slack lists.
  const rows = orderGroupRows(group, [...rowById.values()]);
  const shown = rows.slice(
    0,
    expanded || (!compact && rows.length <= OPEN_ROWS)
      ? rows.length
      : compact
        ? 0
        : COLLAPSED_ROWS,
  );
  const hidden = rows.length - shown.length;
  const ids = group.approvals
    .map((a) => a.id)
    .filter((id) => !outcomeOf.has(id));
  // A tagged batch still arriving holds Approve all, so the reviewer never
  // approves part of a list believing it is the whole task. `now` ticks
  // every second, so the hold lifts on its own once the batch is complete
  // or goes quiet.
  const arrival = batchArrival(
    group.total,
    rows.map((a) => a.createdAt),
    now,
  );
  const first = group.approvals[0];
  const arrivalNote = batchArrivalNote(arrival);

  const pending = rows.filter((a) => !outcomeOf.has(a.id));
  // Only while none of the batch is decided: then the card is about what is
  // left, row by row.
  const merged = pending.length === rows.length ? mergedTable : null;
  // The bell has no room for a table: it keeps its one-line preview, but
  // with the merged title and no false "also in this batch" warning.
  const table = merged && !eachShown && !compact ? merged.bulk : null;
  const otherActions = merged ? [] : group.otherActions;

  // A batch of several requests reads as the changes it makes ("Title →
  // After · 20 contacts") unless the reviewer asks for each request, or a
  // summary would hide something: an odd action, a decided row, rows that
  // all act on ONE record (then what differs is each row, not the record:
  // three files uploaded to one account), or rows that differ too much
  // (then `summarizeChanges` returns null).
  const lines =
    !compact &&
    !merged &&
    rows.length > 1 &&
    pending.length === rows.length &&
    group.otherActions.length === 0 &&
    !shareOneRecord(rows)
      ? summarizeChanges(rows)
      : null;
  // Only when it shortens the card: if every row is its own change, the
  // rows already read as well as any summary.
  const changeLines = lines && lines.length < rows.length ? lines : null;
  // The reviewer can flip between the summary and each request for as long
  // as a summary stays honest (no row decided yet).
  const summarizable = changeLines !== null;
  const summarized = summarizable && !eachShown;
  // Every record is named on the summary, so Approve all needs no reveal.
  // The merged table lists every record (it scrolls), so neither does it.
  const unseen = table
    ? false
    : summarized
      ? changeLines.some((l) => l.rows.length > NAMES_SHOWN)
      : hidden > 0;
  const noun = recordNounOf(first);

  // Every row acts on one record ("Upload file to Account Acme"): the title
  // names it once, linked. Otherwise the title is the verb and each row
  // leads with its own record; a name two rows share gets its id.
  const sharedRecord = shareOneRecord(rows);
  const nameCounts = new Map<string, number>();
  for (const a of rows) {
    const name = a.summary?.subject?.record;
    if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const layoutOf = (a: PendingApproval) => ({
    ownRecord: !sharedRecord,
    disambiguate:
      !sharedRecord &&
      (nameCounts.get(a.summary?.subject?.record ?? "") ?? 0) > 1,
  });
  const mergedTitle = merged ? bulkTitle(merged.bulk) : null;
  const title = mergedTitle ? (
    mergedTitle
  ) : sharedRecord ? (
    <ApprovalTitle summary={first?.summary} fallback={group.mainAction} />
  ) : (
    group.mainAction
  );

  const decideRow = (a: PendingApproval, decision: ApprovalDecisionInput) => {
    setLocal((m) => ({
      ...m,
      [a.id]: {
        approval: a,
        outcome: decision === "approve" ? "approved" : "denied",
      },
    }));
    decide.mutate(
      { ids: [a.id], decision },
      // A decision that didn't go through makes the row live again.
      {
        onSuccess: ({ failed }) => {
          if (failed.length === 0) return;
          setLocal((m) =>
            Object.fromEntries(Object.entries(m).filter(([id]) => id !== a.id)),
          );
        },
      },
    );
  };

  // Approve all only ever covers rows the reviewer can see: while some are
  // collapsed behind "Show all", the approve button reveals them instead.
  // Denying is the safe direction, so Deny all stays one click.
  const decideAll = (decision: ApprovalDecisionInput) => {
    if (decision === "approve" && arrival.arriving) return;
    if (decision === "approve" && unseen) {
      setEachShown(true);
      setExpanded(true);
      return;
    }
    decide.mutate({ ids, decision });
  };

  return (
    <div
      role="group"
      aria-label={`${mergedTitle ?? group.mainAction}: ${ids.length} requests waiting for approval`}
      tabIndex={compact ? undefined : 0}
      onKeyDown={
        compact
          ? undefined
          : (e) => {
              // The card itself, never a link or button inside it.
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter") {
                e.preventDefault();
                decideAll("approve");
              } else if (e.key === "Escape") {
                e.preventDefault();
                decideAll("deny");
              }
            }
      }
      className={cn(
        "group/card focus-visible:ring-ring w-full overflow-hidden focus-visible:ring-2 focus-visible:outline-none",
        section ? "focus-visible:ring-inset" : "bg-muted/50 rounded-xl border",
      )}
    >
      <div
        className={cn(
          "flex gap-2.5 px-4 pt-3 pb-1",
          compact ? "items-start" : "items-center",
        )}
      >
        {section ? (
          <span
            aria-hidden="true"
            className={cn(
              "size-2 shrink-0 rounded-full",
              actionTone(group.mainAction).dot,
            )}
          />
        ) : (
          <span className={cn("flex shrink-0", compact && "pt-0.5")}>
            <ApprovalAppIcon appId={first?.app} />
          </span>
        )}
        <p
          className={cn(
            "min-w-0 text-sm font-semibold",
            // The bell is narrow: let the title (and its linked record)
            // wrap to two lines rather than clip mid-name.
            compact ? "line-clamp-2 break-words" : "truncate",
            section &&
              cn("rounded-md px-1.5 py-0.5", actionTone(group.mainAction).pill),
          )}
        >
          <span className="sr-only">Approval needed: </span>
          {title}
        </p>
        {!compact && (
          <span
            className={cn(
              "text-muted-foreground ms-auto shrink-0 text-xs tabular-nums",
              urgent && "font-medium text-amber-600 dark:text-amber-500",
            )}
          >
            expires in {formatCountdown(remaining)}
          </span>
        )}
      </div>
      <p
        className={cn(
          "text-muted-foreground px-4 pb-2 text-xs",
          compact && "ps-[2.625rem]",
        )}
      >
        {showAgent && first && `${first.agent.name} · `}
        {`${ids.length} waiting`}
        {!compact &&
          ids.length > 1 &&
          (table
            ? ` · one approval covers all ${table.rows.length}, exactly as in the table`
            : " · decide each row, or all at once")}
        {compact && (
          <span
            className={cn(
              "tabular-nums",
              urgent && "font-medium text-amber-600 dark:text-amber-500",
            )}
          >
            {" "}
            · expires in {formatCountdown(remaining)}
          </span>
        )}
      </p>
      {(group.label || group.total) && (
        <p
          className={cn(
            "text-muted-foreground truncate px-4 pb-2 text-xs",
            compact && "ps-[2.625rem]",
          )}
        >
          The agent says: {group.label ? `“${group.label}”` : "one task"}
          {group.total ? ` · ${group.total} requests in total` : ""}
        </p>
      )}
      {!compact && arrivalNote && (
        <p
          role="status"
          className="mx-4 mb-2 rounded-md bg-sky-500/10 px-2 py-1 text-xs font-medium text-sky-800 dark:text-sky-300"
        >
          {/* While arriving, the button says "Waiting for N more". */}
          {arrivalNote}
        </p>
      )}

      {otherActions.length > 0 && (
        <p className="mx-4 mb-2 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-800 dark:text-amber-300">
          <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
          Also in this batch:{" "}
          {otherActions.map((o) => `${o.count} ${o.action}`).join(", ")}
        </p>
      )}

      {compact && !expanded && (
        <p className="truncate px-4 ps-[2.625rem] pb-3 text-sm">
          {rows
            .slice(0, 2)
            .map(
              (a) =>
                groupRowFields(a, layoutOf(a))[0]?.value ?? a.summary?.action,
            )
            .join(" · ")}
          {rows.length > 2 && (
            <span className="text-muted-foreground">
              {" "}
              · +{rows.length - 2} more
            </span>
          )}
        </p>
      )}

      {table ? (
        <>
          <ApprovalBulkPreview bulk={table} className="px-4 pb-2" />
          <div className="px-4 pb-2">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setEachShown(true);
                setExpanded(true);
              }}
              className="text-muted-foreground hover:text-foreground -ms-2"
            >
              {`Decide each request (${rows.length})`}
            </Button>
          </div>
        </>
      ) : summarized ? (
        <>
          <ApprovalChangeSummary
            lines={changeLines ?? []}
            noun={noun}
            nameOf={(a) =>
              (layoutOf(a).disambiguate && subjectRow(a.summary)?.value) ||
              a.summary?.subject?.record ||
              ""
            }
          />
          <div className="px-4 pb-2">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setEachShown(true);
                setExpanded(true);
              }}
              className="text-muted-foreground hover:text-foreground -ms-2"
            >
              {`Show each request (${rows.length})`}
            </Button>
          </div>
        </>
      ) : (
        shown.length > 0 && (
          <ul
            className={cn(
              "px-2 pb-1",
              // A long batch scrolls inside the card, so Approve all stays in
              // view beside the rows it decides.
              shown.length > 10 && "max-h-96 overflow-y-auto",
            )}
          >
            {shown.map((a) => (
              <GroupedApprovalRow
                key={a.id}
                approval={a}
                layout={layoutOf(a)}
                odd={!merged && isOddOneOut(group, a)}
                busy={busy}
                outcome={outcomeOf.get(a.id)?.outcome}
                via={outcomeOf.get(a.id)?.via}
                result={outcomeOf.get(a.id)?.result}
                onDecide={(decision) => decideRow(a, decision)}
                onDetails={() => setDetails(a)}
              />
            ))}
          </ul>
        )
      )}
      {!compact && (summarizable || merged) && eachShown && (
        <div className="px-4 pb-2">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setEachShown(false)}
            className="text-muted-foreground hover:text-foreground -ms-2"
          >
            {merged ? "Show as one table" : "Show summary"}
          </Button>
        </div>
      )}
      {/* The bell's collapsed card expands through "Review all" alone. */}
      {!summarized && !table && hidden > 0 && shown.length > 0 && (
        <div className="px-4 pb-2">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setExpanded(true)}
            className="text-muted-foreground hover:text-foreground -ms-2"
          >
            {`Show all ${rows.length}`}
          </Button>
        </div>
      )}

      <div
        className={cn(
          "flex items-center gap-2 px-4 py-2",
          section ? "pb-3" : "bg-background/50 border-t",
        )}
      >
        {!compact && (
          <p className="text-muted-foreground min-w-0 truncate text-xs">
            <span className="hidden group-focus/card:inline">
              {unseen ? "↵ show all" : "↵ approve all"} · esc deny all
            </span>
            <span className="group-focus/card:hidden">
              Undecided means denied.
            </span>
          </p>
        )}
        <div className="ms-auto flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="xs"
            disabled={busy || ids.length === 0}
            onClick={() => decideAll("deny")}
            className="text-destructive hover:text-destructive"
          >
            <X aria-hidden="true" className="size-3.5" />
            Deny all
          </Button>
          <Button
            size="xs"
            disabled={busy || ids.length === 0 || arrival.arriving}
            onClick={() => decideAll("approve")}
          >
            <Check aria-hidden="true" className="size-3.5" />
            {arrival.arriving
              ? `Waiting for ${(arrival.total ?? 0) - arrival.arrived} more`
              : unseen
                ? `Review all ${ids.length}`
                : // Counted in records, like Slack's "Approve all 9":
                  // what the reviewer is approving is the table.
                  `Approve all ${table ? table.rows.length : ids.length}`}
          </Button>
        </div>
      </div>

      <ApprovalDetailsDialog
        approval={details}
        onClose={() => setDetails(null)}
      />
    </div>
  );
};
