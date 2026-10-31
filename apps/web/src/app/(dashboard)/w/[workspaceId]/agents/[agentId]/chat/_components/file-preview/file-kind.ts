import { isPreviewableImageType } from "@onecli/api/validations/attachments";

/**
 * How a file is previewed, decided in ONE place for every surface (the
 * composer's staged files and the chat's sent ones), so they can never
 * disagree about what renders as what.
 *
 * SECURITY: "image" is the raster allowlist only (`isPreviewableImageType`):
 * an SVG is never rendered as an image here. A PDF is drawn to pixels by
 * pdf.js (never opened as a document in this origin), and text is a fixed
 * plain-data allowlist shown verbatim in a `<pre>`, never parsed as markup.
 * Everything else is a card that shows only the name: its bytes are never
 * read for display.
 */
type PreviewKind = "image" | "pdf" | "text" | "card";

/** Text shown verbatim in a `<pre>`: a fixed allowlist of plain-data types,
 * never a markup type (HTML, SVG, XML-with-scripts) even though React would
 * escape it: the rule stays obviously safe. */
const TEXT_EXTENSIONS = /\.(csv|tsv|txt|md|json|log|ya?ml)$/i;
const TEXT_TYPES = new Set([
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "text/markdown",
  "application/json",
]);

export const previewKind = (name: string, mimeType: string): PreviewKind => {
  const type = mimeType.trim().toLowerCase();
  const inferExtension = type === "" || type === "application/octet-stream";
  if (isPreviewableImageType(type)) return "image";
  if (type === "application/pdf" || (inferExtension && /\.pdf$/i.test(name)))
    return "pdf";
  if (TEXT_TYPES.has(type) || (inferExtension && TEXT_EXTENSIONS.test(name)))
    return "text";
  return "card";
};

/** A byte count as the chat shows it: "17KB", "2.3MB". */
export const formatSize = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))}KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

/** A file's type badge: its extension ("PDF", "CSV"), or "FILE". */
export const fileBadge = (name: string): string => {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  return ext && ext.length <= 4 ? ext.toUpperCase() : "FILE";
};

const KIND_LABELS: Record<string, string> = {
  DOC: "Word document",
  DOCX: "Word document",
  XLS: "Excel spreadsheet",
  XLSX: "Excel spreadsheet",
  PPT: "PowerPoint deck",
  PPTX: "PowerPoint deck",
  ZIP: "Archive",
};

/** What a file is, in words: "Word document · 4KB". */
export const describeFile = (name: string, sizeBytes: number): string =>
  `${KIND_LABELS[fileBadge(name)] ?? "File"} · ${formatSize(sizeBytes)}`;
