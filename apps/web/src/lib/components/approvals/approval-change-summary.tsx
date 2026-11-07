"use client";

import type { ChangeLine } from "@onecli/api/lib/approval-groups";
import { pluralLabel } from "@onecli/api/lib/record-change";
import type { PendingApproval } from "@/lib/api/approvals";
import { ApprovalLink } from "./approval-link";

/** Names listed per change before the rest read "+N more". A change past
 *  this names fewer records than it touches, so Approve all reveals first. */
export const NAMES_SHOWN = 25;

/**
 * A batch as the changes it makes: one line per distinct change ("Title →
 * After") with how many records it touches, then those records by name
 * (linked). Twenty updates to one value read as one line, a reassignment
 * to three owners as three, so the reviewer checks WHAT changes once and
 * WHERE as a list, instead of twenty near-identical rows.
 */
export const ApprovalChangeSummary = ({
  lines,
  noun,
  nameOf,
}: {
  lines: ChangeLine<PendingApproval>[];
  /** What the records are, singular ("contact"), for the counts. */
  noun: string;
  /** A record as listed: its name, or with its id when another record on
   *  the card shares the name, so no two entries read alike. */
  nameOf: (a: PendingApproval) => string;
}) => (
  <ul className="space-y-2 px-4 pb-2">
    {lines.map((line) => {
      const shown = line.rows.slice(0, NAMES_SHOWN);
      const more = line.rows.length - shown.length;
      const key = line.rows.map((r) => r.id).join(",");
      return (
        <li key={key} className="bg-background/60 rounded-md border px-3 py-2">
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-medium">
              {line.fields
                .map(([label, value]) => `${label} → ${value}`)
                .join(" · ")}
            </span>
            <span className="text-muted-foreground text-xs">
              {line.rows.length} {pluralLabel(noun, line.rows.length)}
            </span>
          </p>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            {shown.map((r, i) => (
              <span key={r.id}>
                {i > 0 && ", "}
                <ApprovalLink href={r.summary?.subject?.url}>
                  {nameOf(r)}
                </ApprovalLink>
              </span>
            ))}
            {more > 0 && `, +${more} more`}
          </p>
        </li>
      );
    })}
  </ul>
);
