"use client";

import { cn } from "@onecli/ui/lib/utils";
import { useEffect, useState } from "react";
import { renderPdfFirstPage, type RenderedPdf } from "./pdf-thumbnail";

export const PdfPage = ({
  blob,
  title,
  onPages,
  fit = "cover",
}: {
  blob?: Blob;
  title: string;
  onPages?: (pages: number) => void;
  fit?: "cover" | "contain";
}) => {
  const [result, setResult] = useState<{
    blob: Blob;
    page: RenderedPdf;
  } | null>(null);
  const page = result?.blob === blob ? result?.page : undefined;
  useEffect(() => {
    if (!blob) return;
    let active = true;
    void renderPdfFirstPage(blob).then((page) => {
      if (active) setResult({ blob, page });
    });
    return () => {
      active = false;
    };
  }, [blob]);
  useEffect(() => {
    onPages?.(page?.pages ?? 0);
  }, [page, onPages]);
  return (
    <div className="absolute inset-0 overflow-hidden bg-white">
      {page?.image ? (
        // eslint-disable-next-line @next/next/no-img-element -- locally rendered PDF pixels
        <img
          src={page.image}
          alt={title}
          className={cn(
            "motion-safe:animate-in motion-safe:fade-in size-full object-top duration-200",
            fit === "contain" ? "object-contain" : "object-cover",
          )}
        />
      ) : page ? (
        <p
          role="status"
          className="text-muted-foreground line-clamp-3 p-3 text-xs break-words"
        >
          Preview unavailable: {title}
        </p>
      ) : (
        <span role="status" className="sr-only">
          Loading preview
        </span>
      )}
    </div>
  );
};
