"use client";

import { isProse } from "@onecli/api/lib/approval-text";
import { cn } from "@onecli/ui/lib/utils";
import type { ApprovalDetail } from "@/lib/api/approvals";
import { ApprovalLink } from "./approval-link";
import { ClampedText } from "./clamped-text";

/**
 * The parsed request as label/value rows (a CRM record's fields, a generic
 * JSON call), with record references linked.
 * Short values sit inline after their label; prose (`isProse`: an email
 * body, a description) gets its own soft quote block.
 * Emails and events have richer previews (`ApprovalPreview`).
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
      isProse(d.value) ? (
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
