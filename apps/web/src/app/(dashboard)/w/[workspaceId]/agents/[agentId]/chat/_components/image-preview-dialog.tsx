"use client";

import { Download, ImageOff, Loader2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@onecli/ui/components/dialog";
import type { AttachmentMeta } from "@/lib/api/types";
import {
  useAttachmentBlobUrl,
  useDownloadAttachment,
} from "@/hooks/use-attachments";
import { AttachmentThumb } from "./attachment-thumb";

export interface ImagePreviewDialogProps {
  conversationId: string;
  attachment: AttachmentMeta & { objectUrl?: string };
}

/**
 * One image attachment: its thumbnail, which opens a larger in-app preview
 * with the caption and an explicit Download button. The thumbnail is the
 * dialog's trigger, so closing hands focus back to it.
 *
 * SECURITY: only RASTER types reach here (the chips' allowlist), and the
 * bytes render through an `<img>` from the same cached object URL the thumb
 * uses: never a navigation to the blob, so nothing renders as a document in
 * this origin. Download goes through `useDownloadAttachment` (a saved file,
 * never a navigation).
 */
export const ImagePreviewDialog = ({
  conversationId,
  attachment,
}: ImagePreviewDialogProps) => {
  const fetched = useAttachmentBlobUrl(
    conversationId,
    attachment.id,
    attachment.objectUrl === undefined,
  );
  const download = useDownloadAttachment(conversationId);
  const url = attachment.objectUrl ?? fetched.data;

  return (
    <Dialog>
      <DialogTrigger
        aria-label={`Preview ${attachment.name}`}
        className="focus-visible:ring-ring cursor-zoom-in rounded-md transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none"
      >
        <AttachmentThumb
          conversationId={conversationId}
          attachmentId={attachment.id}
          name={attachment.name}
          objectUrl={attachment.objectUrl}
        />
      </DialogTrigger>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader className="min-w-0">
          <DialogTitle className="truncate pr-6">{attachment.name}</DialogTitle>
          <DialogDescription
            className={attachment.caption ? undefined : "sr-only"}
          >
            {attachment.caption || "Image preview"}
          </DialogDescription>
        </DialogHeader>

        <div className="bg-muted flex min-h-48 items-center justify-center overflow-hidden rounded-md border">
          {fetched.isError ? (
            <div className="text-muted-foreground flex flex-col items-center gap-1 text-sm">
              <ImageOff className="size-6" aria-hidden />
              <span>Preview failed</span>
            </div>
          ) : url ? (
            // eslint-disable-next-line @next/next/no-img-element -- object URLs cannot go through next/image
            <img
              src={url}
              alt={attachment.name}
              className="max-h-[70dvh] w-auto max-w-full object-contain"
            />
          ) : (
            <Loader2
              role="img"
              className="text-muted-foreground size-6 animate-spin"
              aria-label="Loading preview"
            />
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            loading={download.isPending}
            onClick={() => download.mutate(attachment)}
          >
            {!download.isPending && <Download aria-hidden />}
            {download.isPending ? "Downloading…" : "Download"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
