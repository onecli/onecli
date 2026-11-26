"use client";

import { Paperclip } from "lucide-react";
import type { ApprovalDetail } from "@/lib/api/approvals";
import { ApprovalDetailList } from "./approval-detail-list";
import { ApprovalLink } from "./approval-link";
import { pickRows } from "./approval-rows";
import { ClampedText } from "./clamped-text";

const HEADERS = ["Thread", "To", "Cc", "Bcc"];

/**
 * The email as it will arrive: a small message sheet with the thread,
 * recipients and subject as headers, then the body as the reader will see it.
 */
export const ApprovalEmailPreview = ({
  details,
}: {
  details: ApprovalDetail[];
}) => {
  const { get, rest } = pickRows(details, [
    ...HEADERS,
    "Subject",
    "Attachments",
    "Body",
  ]);
  const subject = get("Subject");
  const body = get("Body");
  const attachments = get("Attachments");
  const headers = HEADERS.map(get).filter((d) => d !== undefined);

  return (
    <div className="bg-background overflow-hidden rounded-lg border text-sm">
      <dl className="space-y-1 border-b px-3 py-2">
        {headers.map((d) => (
          <div key={d.label} className="flex gap-2">
            <dt className="text-muted-foreground w-14 shrink-0">{d.label}</dt>
            <dd className="min-w-0 break-words">
              <ApprovalLink href={d.url}>{d.value}</ApprovalLink>
            </dd>
          </div>
        ))}
      </dl>
      <div className="space-y-2 px-3 py-2.5">
        {subject && (
          <p className="font-semibold break-words">
            <span className="sr-only">Subject: </span>
            {subject.value}
          </p>
        )}
        {body && <ClampedText detail={body} lines={6} />}
        {attachments && (
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Paperclip aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="sr-only">Attachments: </span>
            {attachments.value}
          </p>
        )}
      </div>
      {rest.length > 0 && (
        <ApprovalDetailList details={rest} className="border-t px-3 py-2" />
      )}
    </div>
  );
};
