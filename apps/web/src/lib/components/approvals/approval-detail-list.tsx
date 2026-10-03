"use client";

import { cn } from "@onecli/ui/lib/utils";
import type { ApprovalDetail } from "@/lib/api/approvals";
import { ApprovalLink } from "./approval-link";
import { ClampedText } from "./clamped-text";

/** Past this many characters (or with any line break) a value reads as prose
 *  (an email body, a description) and gets its own block under the label. */
const LONG_VALUE_CHARS = 80;

export const isLongValue = (value: string): boolean =>
  value.length > LONG_VALUE_CHARS || value.includes("\n");

/**
 * The parsed request as label/value rows (a CRM record's fields, a generic
 * JSON call), with record references linked.
 * Short values sit inline after their label; prose gets its own soft quote
 * block. Emails and events have richer previews (`ApprovalPreview`).
 */
export const ApprovalDetailList = ({
  details,
  className,
}: {
  details: ApprovalDetail[];
  className?: string;
}) => (
  <dl className={cn("space-y-1.5 text-sm", className)}>
    {details.map((d, i) =>
      isLongValue(d.value) ? (
        <div key={`${d.label}-${i}`} className="space-y-1">
          <dt className="text-muted-foreground">{d.label}</dt>
          <dd className="border-border bg-background/60 rounded-md border-s-2 px-3 py-2">
            <ClampedText detail={d} />
          </dd>
        </div>
      ) : (
        <div key={`${d.label}-${i}`} className="flex gap-1.5">
          <dt className="text-muted-foreground shrink-0">{d.label}:</dt>
          <dd className="min-w-0 break-words">
            <ApprovalLink href={d.url}>{d.value}</ApprovalLink>
          </dd>
        </div>
      ),
    )}
  </dl>
);
