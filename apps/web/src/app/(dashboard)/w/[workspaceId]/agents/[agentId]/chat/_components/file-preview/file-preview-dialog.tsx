"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@onecli/ui/components/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { describeFile, fileBadge, previewKind } from "./file-kind";
import { PdfPage } from "./pdf-page";

/** Text previews show the first lines; anything past this is cut. */
const TEXT_PREVIEW_BYTES = 64 * 1024;

/** The header's quiet icon buttons (Download, Close). */
const ICON_BUTTON =
  "text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring flex size-8 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50";

export interface FilePreviewDialogProps {
  name: string;
  mimeType: string;
  sizeBytes: number;
  caption?: string | null;
  /** An image URL that already exists (a local object URL, or the chat
   * tile's cached one), so opening the preview fetches nothing. */
  imageUrl?: string;
  /** Stable file identity, scoped to its workspace and agent for remote files. */
  previewKey: string;
  /** The file's bytes, read only when the preview first opens. Forward the
   * signal when the callback performs a network request. */
  loadBlob: (signal?: AbortSignal) => Promise<Blob>;
  /** Sent files offer Download; staged ones (still on the user's disk)
   * don't. */
  onDownload?: () => void;
  downloading?: boolean;
  /** The card or tile that opens the preview. As the dialog's trigger it
   * gets focus back when the dialog closes. */
  children: ReactNode;
}

/**
 * The ONE file preview, for files the user is about to send and files
 * already in the chat, laid out like Claude's: a slim header (name, a
 * Download icon, close) over the file on a soft surface, with its facts
 * under it and a Download button in their place on hover. An image
 * full size, a PDF's first page with its page count (enough to recognize
 * it), a text file's first lines, any other type a plain card naming what
 * it is. Bytes are read once, on first open, and kept for re-opens.
 */
export const FilePreviewDialog = ({
  name,
  mimeType,
  sizeBytes,
  caption,
  imageUrl,
  previewKey,
  loadBlob,
  onDownload,
  downloading = false,
  children,
}: FilePreviewDialogProps) => {
  const kind = previewKind(name, mimeType);
  const [open, setOpen] = useState(false);
  const [objectImage, setObjectImage] = useState<{
    blob: Blob;
    url: string;
  } | null>(null);
  const [pageCount, setPageCount] = useState<{
    key: string;
    pages: number;
  } | null>(null);
  const pages = pageCount?.key === previewKey ? pageCount.pages : 0;
  const onPages = useCallback(
    (pages: number) => setPageCount({ key: previewKey, pages }),
    [previewKey],
  );
  const [failedImage, setFailedImage] = useState<string>();
  const closeRef = useRef<HTMLButtonElement>(null);
  const preview = useQuery({
    queryKey: ["file-preview", previewKey, kind],
    queryFn: async ({ signal }) => {
      const blob = await loadBlob(signal);
      signal.throwIfAborted();
      if (kind === "text") {
        const text = await blob.slice(0, TEXT_PREVIEW_BYTES).text();
        signal.throwIfAborted();
        return { kind: "text" as const, text };
      }
      return { kind, blob };
    },
    enabled: open && kind !== "card" && !(kind === "image" && imageUrl),
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
  });
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!open) return;
    return () => {
      void queryClient.cancelQueries({
        queryKey: ["file-preview", previewKey, kind],
        exact: true,
      });
    };
  }, [open, previewKey, kind, queryClient]);
  const loaded = preview.data;
  const imageBlob = loaded?.kind === "image" ? loaded.blob : undefined;
  useEffect(() => {
    if (!imageBlob || !open) return;
    const url = URL.createObjectURL(imageBlob);
    setObjectImage({ blob: imageBlob, url });
    return () => URL.revokeObjectURL(url);
  }, [imageBlob, open]);

  const image =
    imageUrl ??
    (open && objectImage?.blob === imageBlob ? objectImage?.url : undefined);
  const previewFailed =
    preview.isError || (image !== undefined && failedImage === image);
  const showCard = kind === "card" || previewFailed;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        showCloseButton={false}
        // Focus starts on Close, not Download: focus on Download would pop
        // its tooltip on open, and Escape would close the tooltip instead
        // of the preview.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          closeRef.current?.focus();
        }}
        // Sized by kind, known from the file alone: the dialog opens at its
        // final size and never jumps once the bytes arrive.
        className={
          "gap-0 overflow-hidden p-0 " +
          (kind === "image" || kind === "text" ? "sm:max-w-3xl" : "sm:max-w-md")
        }
      >
        <div className="flex items-center gap-2 py-2 pr-2 pl-4">
          <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium">
            {name}
          </DialogTitle>
          {onDownload && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onDownload}
                  disabled={downloading}
                  aria-label={`Download ${name}`}
                  className={ICON_BUTTON}
                >
                  {downloading ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Download className="size-4" aria-hidden />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>Download</TooltipContent>
            </Tooltip>
          )}
          <DialogClose
            ref={closeRef}
            aria-label="Close"
            className={ICON_BUTTON}
          >
            <X className="size-4" aria-hidden />
          </DialogClose>
        </div>
        <DialogDescription className={caption ? "px-4 pb-2" : "sr-only"}>
          {caption || "File preview"}
        </DialogDescription>

        <div className="group/preview bg-muted/40 flex flex-col items-center gap-2 border-t px-6 pt-6 pb-3">
          {showCard ? (
            // Unsupported types and failed previews keep the file's identity visible.
            <>
              <div className="bg-background text-muted-foreground flex size-20 items-center justify-center rounded-xl border text-sm font-semibold tracking-wide shadow-sm">
                {fileBadge(name)}
              </div>
              {previewFailed && (
                <p role="status" className="text-muted-foreground text-sm">
                  Preview unavailable
                  {onDownload ? ". Download the file to view it." : "."}
                </p>
              )}
              <p className="text-muted-foreground text-sm">
                {describeFile(name, sizeBytes)}
              </p>
            </>
          ) : kind === "image" ? (
            image ? (
              // eslint-disable-next-line @next/next/no-img-element -- object URLs cannot go through next/image
              <img
                src={image}
                alt={name}
                onError={() => setFailedImage(image)}
                className="max-h-[70dvh] w-auto max-w-full rounded-md object-contain shadow-sm"
              />
            ) : (
              <Loader2
                role="img"
                aria-label="Loading preview"
                className="text-muted-foreground my-16 size-6 animate-spin"
              />
            )
          ) : kind === "pdf" ? (
            // The first page on the surface, like a sheet of paper: the
            // frame is there from the first paint and the page fades in.
            <>
              <div className="relative aspect-[1/1.3] w-64 overflow-hidden rounded-sm shadow-md ring-1 ring-black/5">
                <PdfPage
                  blob={loaded?.kind === "pdf" ? loaded.blob : undefined}
                  title={name}
                  fit="contain"
                  onPages={onPages}
                />
              </div>
            </>
          ) : (
            <pre className="bg-background max-h-[60dvh] min-h-32 w-full overflow-auto rounded-md p-4 font-mono text-xs whitespace-pre-wrap shadow-sm ring-1 ring-black/5">
              {loaded?.kind === "text" ? (
                loaded.text
              ) : (
                <span role="status">Loading preview…</span>
              )}
            </pre>
          )}
          {/* One fixed-height line under the file: its facts (page count)
              at rest, Download on hover or keyboard focus, like Claude's.
              Both share the slot, so nothing shifts. */}
          <div className="relative flex h-8 items-center justify-center">
            <p className="text-muted-foreground text-xs transition-opacity group-focus-within/preview:opacity-0 group-hover/preview:opacity-0">
              {kind === "pdf" &&
                loaded?.kind === "pdf" &&
                pages > 0 &&
                `${pages} ${pages === 1 ? "page" : "pages"}`}
            </p>
            {onDownload && (
              <button
                type="button"
                onClick={onDownload}
                disabled={downloading}
                className="text-primary hover:bg-muted focus-visible:ring-ring absolute inset-x-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium opacity-0 transition-opacity group-focus-within/preview:opacity-100 group-hover/preview:opacity-100 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60 [@media(hover:none)]:opacity-100"
              >
                {downloading ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Download className="size-4" aria-hidden />
                )}
                {downloading ? "Downloading…" : "Download"}
              </button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
