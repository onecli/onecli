/**
 * Conversation attachments (images/files a user sends to a hosted agent):
 * the caps and the shared name/path vocabulary, in ONE leaf module — the
 * control plane (store + dispatch), the runner (pull + chunk) and the
 * supervisor (reassemble + write) must all agree on these, and two
 * definitions would eventually disagree (the sync-budget precedent).
 */

/**
 * Hard per-file byte cap, enforced at every door (web upload, Slack fetch,
 * runner pull, supervisor reassembly). 10MB matches the gateway's own proxied
 * body cap; a larger Slack file is refused with a visible `failed` chip and a
 * context-note mention, never silently dropped.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** DELIVERABLE files per message. Also the manifest bound on the turn wire. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

/**
 * Attachment ROWS one message may reference, deliverable or not. Higher than
 * the deliverable cap on purpose: a channel message can arrive with more
 * files than we accept, and each surplus one is recorded as a byteless
 * `failed` row so the person is told why rather than having the whole message
 * disappear. Bounds the id array a bind query takes.
 */
export const MAX_ATTACHMENT_ROWS_PER_MESSAGE = 20;

/**
 * Per-image ceiling for INLINE vision (jcode `send_message` images). The
 * Anthropic API refuses images above ~5MB base64 and jcode does NOT resize
 * (verified in v0.71.1, still true through v0.81.1: read.rs base64s raw bytes;
 * the provider forwards verbatim) — 3.7MB raw ≈ 4.94MB base64. Bigger
 * images still land on disk and remain readable through the harness's own
 * read tool.
 */
export const INLINE_IMAGE_MAX_BYTES = 3_700_000;

/**
 * TOTAL inline-image budget per turn. jcode's harness-API socket refuses
 * frames over 16MiB (lib.rs MAX_FRAME_BYTES, v0.71.1 through v0.81.1) and inline images ride
 * the SAME frame as the message — five per-image-legal images would blow it.
 * 10MB raw ≈ 13.4MB base64 leaves headroom for the message itself. Packing
 * is by ascending size so the most images fit; the rest degrade to disk.
 */
export const INLINE_IMAGES_TOTAL_MAX_BYTES = 10 * 1024 * 1024;

/** Uploaded-but-never-sent bound, per conversation (swept after 24h). */
export const MAX_PENDING_ATTACHMENTS_PER_CONVERSATION = 20;

/**
 * Raw bytes per `attachment.part` frame. Base64 inflates 4/3: 144_000 raw →
 * 192_000 base64 chars, keeping the serialized frame under the house
 * MAX_SYNC_PART_BYTES (200_000) and well under the runner WS's 256KB
 * drop-whole ceiling. Divisible by 3, so per-part base64 decodes concatenate
 * byte-exactly.
 */
export const ATTACHMENT_CHUNK_RAW_BYTES = 144_000;

/** Belt for the wire schema: the largest legal `dataBase64` a part may carry. */
export const ATTACHMENT_CHUNK_BASE64_CHARS =
  (ATTACHMENT_CHUNK_RAW_BYTES / 3) * 4;

/** The managed root inside the sandbox home where attachments land. */
export const ATTACHMENTS_ROOT = "attachments";

export const MAX_ATTACHMENT_NAME_CHARS = 100;

/**
 * Media types eligible for inline vision — the intersection of what the
 * Anthropic API accepts and what jcode's own read tool treats as an image.
 * Everything else (PDFs included) is disk-only: the harness's read tool
 * handles PDFs natively, and the API has no inline slot for them on this
 * path.
 */
export const INLINE_IMAGE_MEDIA_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

/**
 * Media types the BROWSER may render as an inline preview — the same raster
 * allowlist, and deliberately NOT "anything image/*".
 *
 * SECURITY (stored XSS): a preview turns bytes into an object URL that
 * inherits the app's origin, and an `image/svg+xml` blob opened as a document
 * executes its embedded script there — the download route's
 * `Content-Disposition`/`nosniff` govern only direct navigation to the API
 * URL, never a blob the client re-creates. Anything outside this list renders
 * as a download chip instead (an anchor with `download` never navigates).
 */
export const isPreviewableImageType = (mimeType: string): boolean =>
  INLINE_IMAGE_MEDIA_TYPES.includes(mimeType.toLowerCase());

export const isInlineableImage = (
  mimeType: string,
  sizeBytes: number,
): boolean =>
  isPreviewableImageType(mimeType) &&
  sizeBytes > 0 &&
  sizeBytes <= INLINE_IMAGE_MAX_BYTES;

/**
 * One safe-name definition for the whole pipe. The output always satisfies
 * the home-relative path rules (no separators, no ".", "..", no control
 * bytes) — traversal is unrepresentable AFTER sanitizing, and the wire's
 * homeRelativePathSchema re-checks anyway (belt and braces).
 *
 * Extension-preserving truncation: a screenshot with a 150-char name must
 * stay openable by extension-sniffing tools after the cut.
 */
export const sanitizeAttachmentName = (raw: string): string => {
  const cleaned = [...raw]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .replace(/[/\\]/g, "-")
    .trim()
    // Leading dots would make hidden files (and "."/".." path segments);
    // leading dashes are what "../.." collapses into after the separator
    // replacement — strip the whole prefix in one pass.
    .replace(/^[.\- ]+/, "")
    // Trailing dots/spaces break Windows-side downloads of the same name.
    .replace(/[. ]+$/, "");
  if (cleaned.length === 0) return "file";
  if (cleaned.length <= MAX_ATTACHMENT_NAME_CHARS) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 ? cleaned.slice(dot) : "";
  // An implausibly long "extension" is just a dotted name — cut it plain.
  if (ext.length === 0 || ext.length > 10) {
    return cleaned.slice(0, MAX_ATTACHMENT_NAME_CHARS);
  }
  return `${cleaned.slice(0, MAX_ATTACHMENT_NAME_CHARS - ext.length)}${ext}`;
};

/**
 * Case-insensitive dedupe for one message's file set (the SkillFile
 * "skill.md" precedent: the sandbox filesystem may be case-insensitive, so
 * "Photo.PNG" and "photo.png" must not silently overwrite each other).
 * Suffixes before the extension: photo.png, photo-2.png, photo-3.png.
 */
export const dedupeAttachmentNames = (names: readonly string[]): string[] => {
  const seen = new Set<string>();
  return names.map((name) => {
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let candidate = name;
    for (let n = 2; seen.has(candidate.toLowerCase()); n += 1) {
      // Re-truncate every suffixed candidate: a name already AT the cap would
      // otherwise grow past it, and the wire's manifest schema bounds the
      // name at MAX_ATTACHMENT_NAME_CHARS — an over-long name makes the
      // supervisor drop the whole frame (file silently absent).
      const suffix = `-${n}`;
      const room = MAX_ATTACHMENT_NAME_CHARS - suffix.length - ext.length;
      candidate = `${base.slice(0, Math.max(1, room))}${suffix}${ext}`;
    }
    seen.add(candidate.toLowerCase());
    return candidate;
  });
};

/** Where one attachment lands inside the home, relative. Full turn id — no
 * collision budget to reason about, and the dir doubles as turn provenance. */
export const attachmentSandboxPath = (
  turnId: string,
  safeName: string,
): string => `${ATTACHMENTS_ROOT}/${turnId}/${safeName}`;
