import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_CHUNK_BASE64_CHARS,
  ATTACHMENT_CHUNK_RAW_BYTES,
  INLINE_IMAGE_MAX_BYTES,
  MAX_ATTACHMENT_NAME_CHARS,
  attachmentDownloadDisposition,
  attachmentSandboxPath,
  dedupeAttachmentNames,
  isInlineableImage,
  isPreviewableImageType,
  normalizeAttachmentCaption,
  sanitizeAttachmentName,
} from "./attachments";
import {
  MAX_SYNC_PART_BYTES,
  attachmentManifestEntrySchema,
  homeRelativePathSchema,
  syncFrameByteLength,
  workItemSchema,
} from "./transport";

/**
 * Control characters BUILT from char codes, never written literally: a raw
 * control byte in the source makes git classify the file as binary, which
 * makes its diff — and therefore review and the OSS sync — unreadable.
 */
const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);

describe("sanitizeAttachmentName", () => {
  it("keeps ordinary names intact", () => {
    expect(sanitizeAttachmentName("photo.png")).toBe("photo.png");
    expect(sanitizeAttachmentName("Q3 report (final).pdf")).toBe(
      "Q3 report (final).pdf",
    );
  });

  it("makes traversal unrepresentable", () => {
    expect(sanitizeAttachmentName("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeAttachmentName("..\\..\\boot.ini")).toBe("boot.ini");
    expect(sanitizeAttachmentName("a/b/c.txt")).toBe("a-b-c.txt");
    // Every output must be a single legal home-relative path segment.
    for (const hostile of ["..", ".", "...", "a/../b", ".hidden", `${NUL}x`]) {
      const safe = sanitizeAttachmentName(hostile);
      expect(
        homeRelativePathSchema.safeParse(`attachments/t/${safe}`).success,
      ).toBe(true);
    }
  });

  it("strips control characters and trailing dots/spaces", () => {
    expect(sanitizeAttachmentName(`evil${BEL}name.txt `)).toBe("evilname.txt");
    expect(sanitizeAttachmentName("report.pdf...")).toBe("report.pdf");
  });

  it("falls back for empty and dot-only names", () => {
    expect(sanitizeAttachmentName("")).toBe("file");
    expect(sanitizeAttachmentName("...")).toBe("file");
    expect(sanitizeAttachmentName("   ")).toBe("file");
  });

  it("truncates preserving the extension", () => {
    const long = `${"a".repeat(200)}.png`;
    const safe = sanitizeAttachmentName(long);
    expect(safe.length).toBe(MAX_ATTACHMENT_NAME_CHARS);
    expect(safe.endsWith(".png")).toBe(true);
  });

  it("truncates plainly when the 'extension' is implausible", () => {
    const long = `${"a".repeat(50)}.${"b".repeat(80)}`;
    expect(sanitizeAttachmentName(long).length).toBe(MAX_ATTACHMENT_NAME_CHARS);
  });
});

describe("dedupeAttachmentNames", () => {
  it("suffixes case-insensitive duplicates before the extension", () => {
    expect(
      dedupeAttachmentNames(["photo.png", "Photo.PNG", "photo.png"]),
    ).toEqual(["photo.png", "Photo-2.PNG", "photo-3.png"]);
  });

  it("leaves distinct names untouched", () => {
    expect(dedupeAttachmentNames(["a.txt", "b.txt"])).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  it("does not collide with an existing suffixed name", () => {
    const out = dedupeAttachmentNames(["a.txt", "a-2.txt", "a.txt"]);
    expect(new Set(out.map((n) => n.toLowerCase())).size).toBe(3);
  });

  it("keeps a suffixed AT-CAP name inside the wire's name bound", () => {
    // REGRESSION: suffixing a 100-char name used to push it to 102, which the
    // manifest/part schemas refuse — the supervisor then drops the frame and
    // the file is silently absent. Every output must stay representable.
    const atCap = sanitizeAttachmentName(`${"a".repeat(200)}.png`);
    expect(atCap.length).toBe(MAX_ATTACHMENT_NAME_CHARS);
    const out = dedupeAttachmentNames([atCap, atCap, atCap]);
    for (const name of out) {
      expect(name.length).toBeLessThanOrEqual(MAX_ATTACHMENT_NAME_CHARS);
      expect(
        attachmentManifestEntrySchema.safeParse({
          id: "att",
          path: `attachments/t/${name}`,
          name,
          mimeType: "image/png",
          sizeBytes: 10,
          sha256: "0".repeat(64),
        }).success,
      ).toBe(true);
    }
    expect(new Set(out.map((n) => n.toLowerCase())).size).toBe(3);
  });
});

describe("isPreviewableImageType", () => {
  it("accepts only the raster types the browser may render inline", () => {
    for (const ok of ["image/png", "IMAGE/JPEG", "image/gif", "image/webp"]) {
      expect(isPreviewableImageType(ok)).toBe(true);
    }
  });

  it("REFUSES image/svg+xml — an SVG preview is a stored-XSS vector", () => {
    // MUTATION-TESTED: widen this to `image/*` and an uploaded SVG becomes a
    // same-origin blob document whose embedded script runs in the app origin.
    expect(isPreviewableImageType("image/svg+xml")).toBe(false);
    expect(isPreviewableImageType("image/svg+xml; charset=utf-8")).toBe(false);
    expect(isPreviewableImageType("text/html")).toBe(false);
    expect(isPreviewableImageType("application/pdf")).toBe(false);
  });
});

describe("isInlineableImage", () => {
  it("accepts the vision media types under the cap", () => {
    expect(isInlineableImage("image/png", 1024)).toBe(true);
    expect(isInlineableImage("IMAGE/JPEG", INLINE_IMAGE_MAX_BYTES)).toBe(true);
  });
  it("refuses oversize, zero, and non-image types", () => {
    expect(isInlineableImage("image/png", INLINE_IMAGE_MAX_BYTES + 1)).toBe(
      false,
    );
    expect(isInlineableImage("image/png", 0)).toBe(false);
    expect(isInlineableImage("application/pdf", 1024)).toBe(false);
    expect(isInlineableImage("image/svg+xml", 1024)).toBe(false);
  });
});

describe("attachment.part frame budget", () => {
  it("chunk size is base64-concatenation-safe and fits the frame budget", () => {
    expect(ATTACHMENT_CHUNK_RAW_BYTES % 3).toBe(0);
    const frame = {
      kind: "attachment.part",
      turnId: "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c",
      attachmentId: "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8d",
      path: `attachments/5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c/${"n".repeat(100)}`,
      name: "n".repeat(100),
      mimeType: "application/octet-stream",
      sizeBytes: 10 * 1024 * 1024,
      sha256: "a".repeat(64),
      part: 999,
      of: 999,
      dataBase64: "A".repeat(ATTACHMENT_CHUNK_BASE64_CHARS),
    };
    expect(workItemSchema.safeParse(frame).success).toBe(true);
    expect(syncFrameByteLength(frame)).toBeLessThanOrEqual(MAX_SYNC_PART_BYTES);
  });

  it("refuses an over-budget or malformed dataBase64", () => {
    const base = {
      kind: "attachment.part",
      turnId: "t",
      attachmentId: "a",
      path: "attachments/t/f.png",
      name: "f.png",
      mimeType: "image/png",
      sizeBytes: 10,
      sha256: "a".repeat(64),
      part: 1,
      of: 1,
    };
    expect(
      workItemSchema.safeParse({
        ...base,
        dataBase64: "A".repeat(ATTACHMENT_CHUNK_BASE64_CHARS + 4),
      }).success,
    ).toBe(false);
    expect(
      workItemSchema.safeParse({ ...base, dataBase64: "not base64!!" }).success,
    ).toBe(false);
  });
});

describe("attachmentManifestEntrySchema", () => {
  const entry = {
    id: "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8d",
    path: attachmentSandboxPath("turn-1", "photo.png"),
    name: "photo.png",
    mimeType: "image/png",
    sizeBytes: 12345,
    sha256: "0".repeat(64),
  };
  it("accepts a well-formed entry", () => {
    expect(attachmentManifestEntrySchema.safeParse(entry).success).toBe(true);
  });
  it("refuses traversal paths and bad hashes", () => {
    expect(
      attachmentManifestEntrySchema.safeParse({
        ...entry,
        path: "attachments/../etc",
      }).success,
    ).toBe(false);
    expect(
      attachmentManifestEntrySchema.safeParse({ ...entry, sha256: "xyz" })
        .success,
    ).toBe(false);
  });
});

describe("normalizeAttachmentCaption", () => {
  it("keeps one printable line, collapses whitespace, strips control chars, caps length, and nulls the empty", () => {
    expect(normalizeAttachmentCaption("the run")).toBe("the run");
    expect(normalizeAttachmentCaption("  the\n\nrun\t\tlive \r\n")).toBe(
      "the run live",
    );
    expect(normalizeAttachmentCaption("a\u0007b\u001bc\u007fd")).toBe(
      "a b c d",
    );
    expect(normalizeAttachmentCaption("x".repeat(600))).toHaveLength(500);
    expect(normalizeAttachmentCaption("")).toBeNull();
    expect(normalizeAttachmentCaption("\u0000\u0001 \n")).toBeNull();
    expect(normalizeAttachmentCaption(null)).toBeNull();
    expect(normalizeAttachmentCaption(undefined)).toBeNull();
  });
});

describe("attachmentDownloadDisposition", () => {
  it("is always an attachment with an ASCII fallback and the UTF-8 real name", () => {
    expect(attachmentDownloadDisposition("clip <1>.webm")).toBe(
      `attachment; filename="clip <1>.webm"; filename*=UTF-8''clip%20%3C1%3E.webm`,
    );
    expect(attachmentDownloadDisposition("résumé.pdf")).toBe(
      `attachment; filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`,
    );
  });

  it("a hostile name cannot break out of the quoted-string: no injected parameter, no CR/LF", () => {
    const header = attachmentDownloadDisposition('a"; filename="evil.html\\');
    expect(header).toBe(
      `attachment; filename="a'; filename='evil.html'"; filename*=UTF-8''a%22%3B%20filename%3D%22evil.html%5C`,
    );
    expect(header).not.toMatch(/[\\\r\n]/);
    // Parsed as RFC 6266 does (split on ; outside quotes): three params.
    const params: string[] = [];
    let cur = "";
    let quoted = false;
    for (const ch of header) {
      if (ch === '"') quoted = !quoted;
      if (ch === ";" && !quoted) {
        params.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    params.push(cur.trim());
    expect(params).toHaveLength(3);
    expect(params[0]).toBe("attachment");
  });
});
