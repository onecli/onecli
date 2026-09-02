"use client";

import { Download, FileText, FileWarning, Loader2 } from "lucide-react";
import { isPreviewableImageType } from "@onecli/api/validations/attachments";
import type { AttachmentMeta } from "@/lib/api/types";
import { useDownloadAttachment } from "@/hooks/use-attachments";
import { AttachmentThumb } from "./attachment-thumb";

/**
 * A message's attachments, under its bubble: raster images as thumbnails,
 * everything else as name+size chips, failed channel fetches as an honest
 * destructive chip. Clicking any of them SAVES the file (never navigates —
 * see `useDownloadAttachment`). Shared by the optimistic pending row (local
 * object URLs) and settled rows (authenticated blob fetch) — the same
 * no-drift rule as UserBubble itself.
 */
export const AttachmentChips = ({
  conversationId,
  attachments,
}: {
  conversationId: string;
  attachments: (AttachmentMeta & { objectUrl?: string })[];
}) => {
  const download = useDownloadAttachment(conversationId);
  if (attachments.length === 0) return null;

  const size = (bytes: number) =>
    bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))}KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

  return (
    <div className="flex max-w-full flex-wrap justify-end gap-2">
      {attachments.map((attachment) => {
        const busy =
          download.isPending && download.variables?.id === attachment.id;

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

        if (isPreviewableImageType(attachment.mimeType)) {
          return (
            <button
              key={attachment.id}
              type="button"
              onClick={() => download.mutate(attachment)}
              disabled={busy}
              aria-label={`Save ${attachment.name}`}
              className="focus-visible:ring-ring relative rounded-md focus-visible:ring-2 focus-visible:outline-none"
            >
              <AttachmentThumb
                conversationId={conversationId}
                attachmentId={attachment.id}
                name={attachment.name}
                objectUrl={attachment.objectUrl}
              />
              {busy && (
                <span className="bg-background/70 absolute inset-0 flex items-center justify-center rounded-md">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                </span>
              )}
            </button>
          );
        }

        return (
          <button
            key={attachment.id}
            type="button"
            onClick={() => download.mutate(attachment)}
            disabled={busy}
            className="bg-muted/50 hover:bg-muted focus-visible:ring-ring flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs focus-visible:ring-2 focus-visible:outline-none"
            aria-label={`Save ${attachment.name}`}
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
