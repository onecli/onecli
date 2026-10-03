"use client";

import { useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import {
  isOddOneOut,
  type ApprovalGroup,
} from "@onecli/api/lib/approval-groups";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import { useDecideApprovals } from "@/hooks/use-approvals";
import type {
  ApprovalDecisionInput,
  PendingApproval,
  SettledOutcome,
} from "@/lib/api/approvals";
import { ApprovalAppIcon } from "./approval-app-icon";
import { ApprovalDetailsDialog } from "./approval-details-dialog";
import { shareOneRecord } from "./approval-rows";
import { ApprovalTitle } from "./approval-title";
import { GroupedApprovalRow, groupRowFields } from "./grouped-approval-row";
import { formatCountdown, useCountdown } from "./use-countdown";

/** Rows shown before "Show all"; the rest stay one click away. */
const COLLAPSED_ROWS = 5;

/** A member decided already, kept on the card with its outcome. */
export interface SettledMember {
  approval: PendingApproval;
  outcome: SettledOutcome;
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
  const [details, setDetails] = useState<PendingApproval | null>(null);
  // A row decided here keeps its outcome until the thread's own settled
  // record catches up: the pending list drops a decided id at once, so the
  // row's approval is snapshotted too, or it would vanish from the card.
  const [local, setLocal] = useState<Record<string, SettledMember>>({});
  const remaining = useCountdown(
    group.expiresAt ? new Date(group.expiresAt).toISOString() : "",
  );
  const urgent = remaining <= 30;
  const busy = decide.isPending;

  const outcomeOf = new Map<string, SettledOutcome>();
  const rowById = new Map(group.approvals.map((a) => [a.id, a]));
  for (const s of [...Object.values(local), ...settled]) {
    outcomeOf.set(s.approval.id, s.outcome);
    if (!rowById.has(s.approval.id)) rowById.set(s.approval.id, s.approval);
  }
  // Odd actions first (a delete among creates can't hide), then arrival.
  const rows = [...rowById.values()].sort(
    (a, b) =>
      Number(isOddOneOut(group, b)) - Number(isOddOneOut(group, a)) ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  const shown = rows.slice(
    0,
    expanded ? rows.length : compact ? 0 : COLLAPSED_ROWS,
  );
  const hidden = rows.length - shown.length;
  const ids = group.approvals
    .map((a) => a.id)
    .filter((id) => !outcomeOf.has(id));
  const first = group.approvals[0];

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
  const title = sharedRecord ? (
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
    if (decision === "approve" && hidden > 0) {
      setExpanded(true);
      return;
    }
    decide.mutate({ ids, decision });
  };

  return (
    <div
      role="group"
      aria-label={`${group.mainAction}: ${ids.length} requests waiting for approval`}
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
        {!compact && ids.length > 1 && " · decide each row, or all at once"}
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

      {group.otherActions.length > 0 && (
        <p className="mx-4 mb-2 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-800 dark:text-amber-300">
          <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
          Also in this batch:{" "}
          {group.otherActions.map((o) => `${o.count} ${o.action}`).join(", ")}
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

      {shown.length > 0 && (
        <ul className="px-2 pb-1">
          {shown.map((a) => (
            <GroupedApprovalRow
              key={a.id}
              approval={a}
              layout={layoutOf(a)}
              odd={isOddOneOut(group, a)}
              busy={busy}
              outcome={outcomeOf.get(a.id)}
              onDecide={(decision) => decideRow(a, decision)}
              onDetails={() => setDetails(a)}
            />
          ))}
        </ul>
      )}
      {/* The bell's collapsed card expands through "Review all" alone. */}
      {hidden > 0 && shown.length > 0 && (
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
              {hidden > 0 ? "↵ show all" : "↵ approve all"} · esc deny all
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
            disabled={busy || ids.length === 0}
            onClick={() => decideAll("approve")}
          >
            <Check aria-hidden="true" className="size-3.5" />
            {hidden > 0
              ? `Review all ${ids.length}`
              : `Approve all ${ids.length}`}
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
