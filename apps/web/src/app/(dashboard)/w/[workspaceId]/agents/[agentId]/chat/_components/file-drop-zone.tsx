"use client";

import { useState } from "react";
import { FileText, Folder, ImageIcon } from "lucide-react";

/**
 * The whole chat pane as a drop target: dragging files anywhere over it shows
 * one overlay, and dropping hands them to `onFiles` (the composer's staging).
 * Without `onFiles` (no composer on screen) it is a plain wrapper.
 */
export const FileDropZone = ({
  onFiles,
  children,
}: {
  onFiles?: (files: FileList) => void;
  children: React.ReactNode;
}) => {
  const [over, setOver] = useState(false);
  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onDragOver={(e) => {
        if (
          !onFiles ||
          e.defaultPrevented ||
          !e.dataTransfer.types.includes("Files")
        )
          return;
        e.preventDefault();
        setOver(true);
      }}
      // Only a leave that exits the pane counts: crossing the transcript,
      // bubbles and composer inside it must not flicker the overlay.
      onDragLeave={(e) => {
        if (
          !(e.relatedTarget instanceof Node) ||
          !e.currentTarget.contains(e.relatedTarget)
        ) {
          setOver(false);
        }
      }}
      onDrop={(e) => {
        setOver(false);
        if (!onFiles || e.defaultPrevented || e.dataTransfer.files.length === 0)
          return;
        e.preventDefault();
        onFiles(e.dataTransfer.files);
      }}
    >
      {children}
      {over && (
        // pointer-events-none: the drag keeps hitting the pane beneath, so
        // the leave check above still sees real targets.
        <div
          role="presentation"
          className="bg-background/60 border-border text-muted-foreground pointer-events-none absolute inset-2 z-50 flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed backdrop-blur-md motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
        >
          <div
            className="flex items-end gap-1.5 motion-safe:animate-in motion-safe:zoom-in-90 motion-safe:duration-200"
            aria-hidden
          >
            <ImageIcon className="size-6 -rotate-12" strokeWidth={1.5} />
            <FileText className="mb-2 size-7" strokeWidth={1.5} />
            <Folder className="size-6 rotate-12" strokeWidth={1.5} />
          </div>
          <p className="text-sm font-medium">Drop files here</p>
        </div>
      )}
    </div>
  );
};
