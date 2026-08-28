"use client";

import { ImageIcon, ImageOff } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
import { useAttachmentBlobUrl } from "@/hooks/use-attachments";

/**
 * One image attachment's inline preview. The optimistic pending row hands a
 * local object URL (no fetch); a settled row fetches the bytes through the
 * authenticated blob endpoint — a bare `<img src>` cannot carry the bearer
 * token, so the URL is always an object URL, never the API path.
 *
 * SECURITY: only RASTER types reach this component (the chips' allowlist),
 * and clicking opens the image in a NEW TAB via a download-typed blob rather
 * than navigating to the render-capable one — a same-origin blob document
 * would execute embedded script in this app's origin.
 */
export const AttachmentThumb = ({
  conversationId,
  attachmentId,
  name,
  objectUrl,
  className,
}: {
  conversationId: string;
  attachmentId: string;
  name: string;
  /** Local preview from the composer; when present, nothing is fetched. */
  objectUrl?: string;
  className?: string;
}) => {
  const fetched = useAttachmentBlobUrl(
    conversationId,
    attachmentId,
    objectUrl === undefined,
  );
  const url = objectUrl ?? fetched.data;

  if (fetched.isError) {
    return (
      <div
        role="img"
        aria-label={`Preview of ${name} could not be loaded`}
        className={cn(
          "bg-muted text-muted-foreground flex h-24 w-32 flex-col items-center justify-center gap-1 rounded-md border text-xs",
          className,
        )}
      >
        <ImageOff className="size-5" aria-hidden />
        <span>Preview failed</span>
      </div>
    );
  }

  if (!url) {
    return (
      <div
        role="img"
        aria-label={`Loading preview of ${name}`}
        className={cn(
          "bg-muted flex h-24 w-32 items-center justify-center rounded-md border",
          className,
        )}
      >
        <ImageIcon
          className="text-muted-foreground size-5 animate-pulse"
          aria-hidden
        />
      </div>
    );
  }

  return (
    <span className={cn("block overflow-hidden rounded-md border", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- object URLs
          cannot go through next/image, and the bytes are already local */}
      <img
        src={url}
        alt={name}
        // Matches the placeholder's footprint, so the thread does not jump as
        // each blob resolves.
        className="h-24 w-32 bg-muted object-contain"
      />
    </span>
  );
};
