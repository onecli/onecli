"use client";

import { Check, Info, X } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import type {
  ApprovalDecisionInput,
  ApprovalDetail,
  PendingApproval,
  SettledOutcome,
} from "@/lib/api/approvals";
import { ApprovalLink } from "./approval-link";
import { rowsBesideTitle, subjectRow } from "./approval-rows";

/** Fields a row shows: the record's identifying values, never all of it. */
const ROW_FIELDS = 3;

/** How a row reads, per the card it sits on. */
interface GroupRowLayout {
  /** The card's title names no record, so each row leads with its own. */
  ownRecord: boolean;
  /** Another row names a record of the same name: show this one's id too. */
  disambiguate: boolean;
}

/**
 * A row's identifying values. When rows don't share one record (ten "Delete
 * Contact <name>"), each leads with its own record, linked: that is what
 * the reviewer decides on. The rest are the first fields beside the title,
 * a first + last name read as one.
 */
export const groupRowFields = (
  a: PendingApproval,
  { ownRecord, disambiguate }: GroupRowLayout,
): ApprovalDetail[] => {
  const subject = a.summary?.subject;
  // The record row's value carries the id ("DR Procedure (069…)"): used
  // when the bare name alone would read like another row's.
  const lead: ApprovalDetail[] =
    ownRecord && subject
      ? [
          {
            label: "Record",
            value:
              (disambiguate && subjectRow(a.summary)?.value) || subject.record,
            url: subject.url,
          },
        ]
      : [];
  const rest = rowsBesideTitle(a.summary);
  const first = rest.find((d) => d.label === "First name");
  const last = rest.find((d) => d.label === "Last name");
  const named =
    first && last
      ? [
          { label: "Name", value: `${first.value} ${last.value}` },
          ...rest.filter((d) => d !== first && d !== last),
        ]
      : rest;
  return [...lead, ...named].slice(0, ROW_FIELDS);
};

const OUTCOME_BADGE: Record<
  SettledOutcome,
  { label: string; icon: typeof Check | null; className: string }
> = {
  approved: {
    label: "Approved",
    icon: Check,
    className:
      "border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400",
  },
  denied: {
    label: "Denied",
    icon: X,
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  expired: {
    label: "Expired",
    icon: null,
    className: "border-border text-muted-foreground",
  },
  decided: {
    label: "Decided elsewhere",
    icon: null,
    className: "border-border text-muted-foreground",
  },
};

/**
 * One request on a grouped card: its identifying fields (records linked),
 * a Details button, and its own labeled Approve / Deny, so deciding one
 * request is as explicit as deciding all of them. Once decided the row
 * stays, disabled, showing only the outcome.
 */
export const GroupedApprovalRow = ({
  approval,
  layout,
  odd,
  busy,
  outcome,
  onDecide,
  onDetails,
}: {
  approval: PendingApproval;
  layout: GroupRowLayout;
  /** Not the card's main action: flagged so it can't hide in the batch. */
  odd: boolean;
  busy: boolean;
  outcome?: SettledOutcome;
  onDecide: (decision: ApprovalDecisionInput) => void;
  onDetails: () => void;
}) => {
  const fields = groupRowFields(approval, layout);
  const action = approval.summary?.action ?? `${approval.method} request`;
  // The odd-one-out tag is the verb alone when the row already leads with
  // its record ("Update Contact · Olivia Martinez", not the name twice).
  const oddLabel =
    (layout.ownRecord && approval.summary?.subject?.verb) || action;
  const name = fields[0]?.value ?? action;
  const badge = outcome ? OUTCOME_BADGE[outcome] : null;
  return (
    <li
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
        odd && !outcome && "bg-amber-500/10",
      )}
    >
      <p className={cn("min-w-0 flex-1 truncate", outcome && "opacity-50")}>
        {odd && (
          <span className="me-1.5 font-medium text-amber-700 dark:text-amber-400">
            {oddLabel}
          </span>
        )}
        {fields.map((d, i) => (
          <span
            key={`${d.label}-${i}`}
            className={i === 0 ? "font-medium" : "text-muted-foreground"}
          >
            {i > 0 && " · "}
            <ApprovalLink href={d.url}>{d.value}</ApprovalLink>
          </span>
        ))}
        {fields.length === 0 && action}
      </p>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onDetails}
        className="text-muted-foreground hover:text-foreground shrink-0"
        aria-label={`Details: ${name}`}
      >
        <Info aria-hidden="true" className="size-3.5" />
      </Button>
      {badge ? (
        <span
          role="status"
          className={cn(
            "inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 text-xs font-medium",
            badge.className,
          )}
        >
          {badge.icon && <badge.icon aria-hidden="true" className="size-3.5" />}
          {badge.label}
        </span>
      ) : (
        <>
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() => onDecide("deny")}
            className="text-destructive hover:text-destructive hover:border-destructive hover:bg-destructive/10 focus-visible:border-destructive shrink-0 gap-1 px-2"
            aria-label={`Deny ${name}`}
          >
            <X aria-hidden="true" className="size-3.5" />
            Deny
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() => onDecide("approve")}
            className="shrink-0 gap-1 px-2 text-emerald-700 hover:border-emerald-600 hover:bg-emerald-600/15 hover:text-emerald-700 focus-visible:border-emerald-600 dark:text-emerald-400"
            aria-label={`Approve ${name}`}
          >
            <Check aria-hidden="true" className="size-3.5" />
            Approve
          </Button>
        </>
      )}
    </li>
  );
};
