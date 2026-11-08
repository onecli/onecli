"use client";

import { cn } from "@onecli/ui/lib/utils";
import type { AttachmentMeta } from "@/lib/api/types";
import { GoneFile } from "./gone-file";
import { SentFile } from "./sent-file";

/** The same preview tiles for optimistic and settled message attachments. */
export const AttachmentChips = ({
  conversationId,
  attachments,
  align = "end",
}: {
  conversationId: string;
  attachments: AttachmentMeta[];
  align?: "start" | "end";
}) => {
  if (attachments.length === 0) return null;
  return (
    <div
      className={cn(
        "flex max-w-full flex-wrap gap-2",
        align === "end" ? "justify-end" : "justify-start",
      )}
    >
      {attachments.map((attachment) =>
        attachment.status === "failed" || attachment.status === "expired" ? (
          <GoneFile key={attachment.id} attachment={attachment} />
        ) : (
          <SentFile
            key={attachment.id}
            conversationId={conversationId}
            attachment={attachment}
          />
        ),
      )}
    </div>
  );
};
