"use client";

import {
  Download,
  FileClock,
  FileText,
  FileWarning,
  Loader2,
} from "lucide-react";
import {
  ATTACHMENT_RETENTION_DAYS,
  isPreviewableImageType,
} from "@onecli/api/validations/attachments";
import { cn } from "@onecli/ui/lib/utils";
import type { AttachmentMeta } from "@/lib/api/types";
import { useDownloadAttachment } from "@/hooks/use-attachments";
import { ImagePreviewDialog } from "./image-preview-dialog";

/**
 * A message's attachments, under its bubble: raster images as thumbnails,
 * everything else as name+size chips, failed channel fetches as an honest
 * destructive chip, expired ones (retention took the bytes) as a quiet
 * inert chip. Clicking an image opens a larger in-app preview (with a
 * Download button); clicking any other live file SAVES it (never navigates;
 * see `useDownloadAttachment`). Shared by the optimistic pending row (local
 * object URLs) and settled rows (authenticated blob fetch) — the same
 * no-drift rule as UserBubble itself.
 */
export const AttachmentChips = ({
  conversationId,
  attachments,
  align = "end",
}: {
  conversationId: string;
  attachments: (AttachmentMeta & { objectUrl?: string })[];
  /** `end` under the person's bubble (the default), `start` under the
   * agent's answer — the same chips, mirrored to their speaker's side. */
  align?: "start" | "end";
}) => {
  const download = useDownloadAttachment(conversationId);
  if (attachments.length === 0) return null;

  const size = (bytes: number) =>
    bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))}KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

  return (
    <div
      className={cn(
        "flex max-w-full flex-wrap gap-2",
        align === "end" ? "justify-end" : "justify-start",
      )}
    >
      {attachments.map((attachment) => {
        if (attachment.status === "failed") {
          return (
            <div
              key={attachment.id}
              className="border-destructive/50 text-destructive flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
              title="This file couldn't be retrieved from the channel"
            >
              <FileWarning className="size-3.5" aria-hidden />
              <span className="max-w-48 truncate">{attachment.name}</span>
              <span>couldn&apos;t be retrieved</span>
            </div>
          );
        }

        if (attachment.status === "expired") {
          return (
            <div
              key={attachment.id}
              className="text-muted-foreground flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-xs"
              title={`This file expired after ${ATTACHMENT_RETENTION_DAYS} days`}
            >
              <FileClock className="size-3.5" aria-hidden />
              <span className="max-w-48 truncate line-through">
                {attachment.name}
              </span>
              <span>expired</span>
            </div>
          );
        }

        if (isPreviewableImageType(attachment.mimeType)) {
          return (
            <ImagePreviewDialog
              key={attachment.id}
              conversationId={conversationId}
              attachment={attachment}
            />
          );
        }

        const busy =
          download.isPending && download.variables?.id === attachment.id;
        return (
          <button
            key={attachment.id}
            type="button"
            onClick={() => download.mutate(attachment)}
            disabled={busy}
            className="bg-muted/50 hover:bg-muted focus-visible:ring-ring flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs focus-visible:ring-2 focus-visible:outline-none"
            aria-label={`Save ${attachment.name}`}
            {...(attachment.caption && { title: attachment.caption })}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <FileText className="size-3.5" aria-hidden />
            )}
            <span className="max-w-48 truncate">{attachment.name}</span>
            <span className="text-muted-foreground">
              {size(attachment.sizeBytes)}
            </span>
            <Download className="text-muted-foreground size-3" aria-hidden />
          </button>
        );
      })}
    </div>
  );
};
