"use client";

import { useEffect, useState } from "react";
import { PdfPage } from "./pdf-page";

const SNIPPET_BYTES = 2 * 1024;

export const FileTileFace = ({
  name,
  kind,
  blob,
}: {
  name: string;
  kind: "pdf" | "text" | "card";
  blob?: Blob;
}) => {
  const [snippet, setSnippet] = useState<{ blob: Blob; text: string } | null>(
    null,
  );
  useEffect(() => {
    if (!blob || kind !== "text") return;
    let active = true;
    void blob
      .slice(0, SNIPPET_BYTES)
      .text()
      .then(
        (text) => {
          if (active) setSnippet({ blob, text });
        },
        () => {
          if (active) setSnippet(null);
        },
      );
    return () => {
      active = false;
    };
  }, [blob, kind]);

  if (kind === "pdf") return <PdfPage blob={blob} title={name} />;
  if (kind === "text" && snippet && snippet.blob === blob) {
    return (
      <pre className="text-muted-foreground absolute inset-0 overflow-hidden p-2.5 font-mono text-[9px] leading-snug whitespace-pre-wrap">
        {snippet.text}
      </pre>
    );
  }
  return (
    <p className="absolute inset-x-0 top-0 line-clamp-3 p-3 text-xs font-medium break-words">
      {name}
    </p>
  );
};
