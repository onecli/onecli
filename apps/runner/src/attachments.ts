import { createHash } from "node:crypto";
import {
  ATTACHMENT_CHUNK_RAW_BYTES,
  type AttachmentManifestEntry,
  type WorkItem,
} from "@onecli/agent-protocol";

/**
 * Turn one attachment's bytes into ordered `attachment.part` frames. Chunked
 * at ATTACHMENT_CHUNK_RAW_BYTES (divisible by 3, so per-part base64 decodes
 * concatenate byte-exactly) — each frame stays under the house 200KB budget
 * and the WS server's silent 256KB drop ceiling. Pure, so the ordering and
 * budget math is unit-testable without a socket.
 */
export const attachmentPartFrames = (
  turnId: string,
  entry: AttachmentManifestEntry,
  bytes: Buffer,
): Extract<WorkItem, { kind: "attachment.part" }>[] => {
  const of = Math.max(
    1,
    Math.ceil(bytes.byteLength / ATTACHMENT_CHUNK_RAW_BYTES),
  );
  const frames: Extract<WorkItem, { kind: "attachment.part" }>[] = [];
  for (let part = 1; part <= of; part += 1) {
    const start = (part - 1) * ATTACHMENT_CHUNK_RAW_BYTES;
    frames.push({
      kind: "attachment.part",
      turnId,
      attachmentId: entry.id,
      path: entry.path,
      name: entry.name,
      mimeType: entry.mimeType,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      part,
      of,
      dataBase64: bytes
        .subarray(start, start + ATTACHMENT_CHUNK_RAW_BYTES)
        .toString("base64"),
    });
  }
  return frames;
};

/**
 * Verify pulled bytes against the manifest BEFORE spending socket frames on
 * them: a mismatch here means the store served something other than what was
 * promised (a mid-flight overwrite, a truncated read) — the supervisor would
 * refuse it anyway, so refuse it a hop earlier.
 */
export const verifyPulledAttachment = (
  entry: AttachmentManifestEntry,
  bytes: Buffer,
): boolean =>
  bytes.byteLength === entry.sizeBytes &&
  createHash("sha256").update(bytes).digest("hex") === entry.sha256;
