"use client";

import { Calendar, MapPin, Users } from "lucide-react";
import type { ApprovalDetail } from "@/lib/api/approvals";
import { ApprovalDetailList } from "./approval-detail-list";
import { pickRows } from "./approval-rows";
import { formatEventWhen } from "./event-time";

/**
 * The event as it will sit on the calendar: title, when, where, who. The
 * "when" line is calendar-style, in the request's own zone (`event-time.ts`).
 */
export const ApprovalEventPreview = ({
  details,
}: {
  details: ApprovalDetail[];
}) => {
  const { get, rest } = pickRows(details, [
    "Title",
    "Start",
    "End",
    "Location",
    "Attendees",
  ]);
  const lines = [
    {
      icon: Calendar,
      label: "When",
      text: formatEventWhen(get("Start")?.value, get("End")?.value),
    },
    { icon: MapPin, label: "Location", text: get("Location")?.value },
    { icon: Users, label: "Attendees", text: get("Attendees")?.value },
  ].filter((line) => line.text);

  return (
    <div className="bg-background overflow-hidden rounded-lg border text-sm">
      <div className="flex gap-3 px-3 py-2.5">
        <span className="bg-primary/70 w-1 shrink-0 rounded-full" />
        <div className="min-w-0 space-y-1.5">
          <p className="font-semibold break-words">
            {get("Title")?.value ?? "Untitled event"}
          </p>
          {lines.map(({ icon: Icon, label, text }) => (
            <p key={label} className="flex items-start gap-2">
              <Icon
                aria-hidden="true"
                className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
              />
              <span className="min-w-0 break-words">
                <span className="sr-only">{label}: </span>
                {text}
              </span>
            </p>
          ))}
        </div>
      </div>
      {rest.length > 0 && (
        <ApprovalDetailList details={rest} className="border-t px-3 py-2" />
      )}
    </div>
  );
};
