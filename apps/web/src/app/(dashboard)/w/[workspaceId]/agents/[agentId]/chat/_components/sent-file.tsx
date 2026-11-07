"use client";

import { ImageOff } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
import {
  useAttachmentBytes,
  useDownloadAttachment,
} from "@/hooks/use-attachments";
import type { AttachmentMeta } from "@/lib/api/types";
import { ATTACHMENT_TILE } from "./attachment-tile";
import { FilePreviewDialog } from "./file-preview/file-preview-dialog";
import { previewKind } from "./file-preview/file-kind";
import { FileTileFace } from "./file-preview/file-tile-face";
import { FileTileBadge } from "./file-preview/file-tile-badge";

/** A live attachment shares fetched bytes between its tile and preview. */
export const SentFile = ({
  conversationId,
  attachment,
}: {
  conversationId: string;
  attachment: AttachmentMeta;
}) => {
  const download = useDownloadAttachment(conversationId);
  const kind = previewKind(attachment.name, attachment.mimeType);
  const bytes = useAttachmentBytes(
    conversationId,
    attachment.id,
    kind !== "card",
  );
  const imageUrl = bytes.data?.url;

  return (
    <FilePreviewDialog
      previewKey={`attachment:${conversationId}:${attachment.id}`}
      name={attachment.name}
      mimeType={attachment.mimeType}
      sizeBytes={attachment.sizeBytes}
      caption={attachment.caption}
      imageUrl={kind === "image" ? imageUrl : undefined}
      loadBlob={async () => {
        const data =
          bytes.data ?? (await bytes.refetch({ throwOnError: true })).data;
        if (!data) throw new Error("Attachment bytes are unavailable");
        return data.blob;
      }}
      onDownload={() => download.mutate(attachment)}
      downloading={download.isPending}
    >
      <button
        type="button"
        aria-label={`Preview ${attachment.name}`}
        title={attachment.caption || undefined}
        className={cn(
          ATTACHMENT_TILE,
          "bg-background hover:border-foreground/20 focus-visible:ring-ring cursor-pointer text-left transition-colors focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none",
        )}
      >
        {kind === "image" ? (
          imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- local object URL
            <img
              src={imageUrl}
              alt={attachment.name}
              className="bg-muted size-full object-cover"
            />
          ) : (
            <span
              role="img"
              aria-label={
                bytes.isError
                  ? `Preview of ${attachment.name} could not be loaded`
                  : `Loading preview of ${attachment.name}`
              }
              className="bg-muted text-muted-foreground flex size-full items-center justify-center"
            >
              {bytes.isError && <ImageOff className="size-5" aria-hidden />}
            </span>
          )
        ) : (
          <>
            <FileTileFace
              name={attachment.name}
              kind={kind}
              blob={bytes.data?.blob}
            />
            <FileTileBadge name={attachment.name} />
          </>
        )}
      </button>
    </FilePreviewDialog>
  );
};
