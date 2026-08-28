import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_CHUNK_RAW_BYTES,
  MAX_SYNC_PART_BYTES,
  syncFrameByteLength,
  type AttachmentManifestEntry,
} from "@onecli/agent-protocol";
import { attachmentPartFrames, verifyPulledAttachment } from "./attachments";

const entryFor = (bytes: Buffer): AttachmentManifestEntry => ({
  id: "att-1",
  path: "attachments/turn-1/photo.png",
  name: "photo.png",
  mimeType: "image/png",
  sizeBytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

describe("attachmentPartFrames", () => {
  it("round-trips bytes across parts, in order, base64-concatenation-safe", () => {
    const bytes = Buffer.alloc(ATTACHMENT_CHUNK_RAW_BYTES * 2 + 5_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7) % 256;
    const frames = attachmentPartFrames("turn-1", entryFor(bytes), bytes);

    expect(frames).toHaveLength(3);
    frames.forEach((frame, i) => {
      expect(frame.part).toBe(i + 1);
      expect(frame.of).toBe(3);
      expect(syncFrameByteLength(frame)).toBeLessThanOrEqual(
        MAX_SYNC_PART_BYTES,
      );
    });
    const reassembled = Buffer.concat(
      frames.map((f) => Buffer.from(f.dataBase64, "base64")),
    );
    expect(reassembled.equals(bytes)).toBe(true);
  });

  it("emits a single part for a small file", () => {
    const bytes = Buffer.from("tiny");
    const frames = attachmentPartFrames("turn-1", entryFor(bytes), bytes);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ part: 1, of: 1 });
  });
});

describe("verifyPulledAttachment", () => {
  it("accepts bytes matching size and hash, rejects either drift", () => {
    const bytes = Buffer.from("the real bytes");
    const entry = entryFor(bytes);
    expect(verifyPulledAttachment(entry, bytes)).toBe(true);
    expect(verifyPulledAttachment(entry, Buffer.from("the real byteX"))).toBe(
      false,
    );
    expect(verifyPulledAttachment({ ...entry, sizeBytes: 999 }, bytes)).toBe(
      false,
    );
  });
});
