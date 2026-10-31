"use client";

import { FileClock, FileWarning } from "lucide-react";
import { ATTACHMENT_RETENTION_DAYS } from "@onecli/api/validations/attachments";
import { cn } from "@onecli/ui/lib/utils";
import { ATTACHMENT_TILE } from "./attachment-tile";
import type { AttachmentMeta } from "@/lib/api/types";

/** Missing bytes are explained in an inert, non-clickable tile. */
export const GoneFile = ({ attachment }: { attachment: AttachmentMeta }) => {
  const failed = attachment.status === "failed";
  return (
    <div
      className={cn(
        ATTACHMENT_TILE,
        "flex flex-col justify-between p-3 text-xs",
        failed
          ? "border-destructive/50 text-destructive"
          : "text-muted-foreground border-dashed",
      )}
      title={
        failed
          ? "This file couldn't be retrieved from the channel"
          : `This file expired after ${ATTACHMENT_RETENTION_DAYS} days`
      }
    >
      <p className={cn("line-clamp-3 break-words", !failed && "line-through")}>
        {attachment.name}
      </p>
      <p className="flex items-center gap-1">
        {failed ? (
          <FileWarning className="size-3.5" aria-hidden />
        ) : (
          <FileClock className="size-3.5" aria-hidden />
        )}
        {failed ? "couldn't be retrieved" : "expired"}
      </p>
    </div>
  );
};
