"use client";

import type { ApprovalSummary } from "@/lib/api/approvals";
import { ApprovalLink } from "./approval-link";

/** A card's title: the action, with the record it is about as the link
 *  ("Upload file to **Account Acme Robotics** ↗"). Falls back to the plain
 *  action, then to `fallback` when there is no summary. */
export const ApprovalTitle = ({
  summary,
  fallback,
}: {
  summary: ApprovalSummary | null | undefined;
  fallback: string;
}) => {
  const subject = summary?.subject;
  if (!subject) return <>{summary?.action ?? fallback}</>;
  return (
    <>
      {subject.lead}
      <ApprovalLink href={subject.url}>{subject.record}</ApprovalLink>
    </>
  );
};
