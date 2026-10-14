"use client";

import type { ApprovalDetail, ApprovalSummary } from "@/lib/api/approvals";
import { ApprovalBulkPreview } from "./approval-bulk-preview";
import { ApprovalDetailList } from "./approval-detail-list";
import { ApprovalEmailPreview } from "./approval-email-preview";
import { ApprovalEventPreview } from "./approval-event-preview";
import { ApprovalRecordPreview } from "./approval-record-preview";

/**
 * What the request will produce, drawn as close as possible to how it will
 * look once it lands: an email as a message, an event as a calendar entry,
 * a change to a whole list of records as that list, and one record as its
 * fields, now and new. Anything else (a generic JSON call) keeps label/value
 * rows, where long values already read as prose.
 */
export const ApprovalPreview = ({
  kind,
  details,
  bulk,
  className,
}: {
  kind: ApprovalSummary["kind"];
  details: ApprovalDetail[];
  bulk?: ApprovalSummary["bulk"];
  className?: string;
}) => {
  if (bulk?.rows.length === 1) {
    return <ApprovalRecordPreview bulk={bulk} className={className} />;
  }
  if (bulk) return <ApprovalBulkPreview bulk={bulk} className={className} />;
  switch (kind) {
    case "email":
      return (
        <div className={className}>
          <ApprovalEmailPreview details={details} />
        </div>
      );
    case "event":
      return (
        <div className={className}>
          <ApprovalEventPreview details={details} />
        </div>
      );
    default:
      return <ApprovalDetailList details={details} className={className} />;
  }
};
