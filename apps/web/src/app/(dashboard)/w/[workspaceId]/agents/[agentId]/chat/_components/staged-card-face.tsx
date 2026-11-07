"use client";

import { Loader2 } from "lucide-react";
import type { StagedAttachment } from "./composer";
import { fileBadge, formatSize } from "./file-preview/file-kind";

/** A staged file's thumbnail or badge, followed by its name and size. */
export const StagedCardFace = ({ entry }: { entry: StagedAttachment }) => (
  <>
    <div className="bg-muted text-muted-foreground flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg text-[10px] font-semibold tracking-wide">
      {entry.status === "uploading" ? (
        <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
      ) : entry.objectUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={entry.objectUrl} alt="" className="size-full object-cover" />
      ) : (
        fileBadge(entry.name)
      )}
    </div>
    <div className="min-w-0 text-xs">
      <p className="truncate font-medium" title={entry.name}>
        {entry.name}
      </p>
      <p className="text-muted-foreground">{formatSize(entry.sizeBytes)}</p>
    </div>
  </>
);
