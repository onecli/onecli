"use client";

import type { ApprovalDetail, ApprovalSummary } from "@/lib/api/approvals";
import { ApprovalDetailList } from "./approval-detail-list";
import { ApprovalEmailPreview } from "./approval-email-preview";
import { ApprovalEventPreview } from "./approval-event-preview";

/**
 * What the request will produce, drawn as close as possible to how it will
 * look once it lands: an email as a message, an event as a calendar entry.
 * Anything else (a CRM record, a generic JSON call) keeps label/value rows,
 * where long values already read as prose.
 */
export const ApprovalPreview = ({
  kind,
  details,
  className,
}: {
  kind: ApprovalSummary["kind"];
  details: ApprovalDetail[];
  className?: string;
}) => {
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
