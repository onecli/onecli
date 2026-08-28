import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ATTACHMENT_CHUNK_RAW_BYTES,
  type WorkItem,
} from "@onecli/agent-protocol";
import {
  createAttachmentAssembler,
  pruneStaleAttachments,
  readMaterializedAttachment,
} from "./attachments";

type Part = Extract<WorkItem, { kind: "attachment.part" }>;

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const partsFor = (
  bytes: Buffer,
  over: Partial<Part> = {},
  chunkSize = ATTACHMENT_CHUNK_RAW_BYTES,
): Part[] => {
  const of = Math.max(1, Math.ceil(bytes.byteLength / chunkSize));
  return Array.from({ length: of }, (_, i) => ({
    kind: "attachment.part" as const,
    turnId: "turn-1",
    attachmentId: "att-1",
    path: "attachments/turn-1/photo.png",
    name: "photo.png",
    mimeType: "image/png",
    sizeBytes: bytes.byteLength,
    sha256: sha(bytes),
    part: i + 1,
    of,
    dataBase64: bytes
      .subarray(i * chunkSize, (i + 1) * chunkSize)
      .toString("base64"),
    ...over,
  }));
};

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "attach-test-"));
});

describe("createAttachmentAssembler", () => {
  it("reassembles multi-part bytes exactly and writes read-only", () => {
    const bytes = Buffer.alloc(ATTACHMENT_CHUNK_RAW_BYTES * 2 + 17_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
    const assembler = createAttachmentAssembler(homeDir);
    for (const part of partsFor(bytes)) assembler.apply(part);

    const target = join(homeDir, "attachments/turn-1/photo.png");
    expect(readFileSync(target).equals(bytes)).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o444);
  });

  it("refuses a checksum mismatch — nothing lands on disk", () => {
    const bytes = Buffer.from("hello attachment");
    const assembler = createAttachmentAssembler(homeDir);
    for (const part of partsFor(bytes, { sha256: "0".repeat(64) })) {
      assembler.apply(part);
    }
    expect(existsSync(join(homeDir, "attachments/turn-1/photo.png"))).toBe(
      false,
    );
  });

  it("drops bytes past the declared size fail-closed", () => {
    const bytes = Buffer.alloc(4096, 7);
    const assembler = createAttachmentAssembler(homeDir);
    for (const part of partsFor(bytes, { sizeBytes: 100 })) {
      assembler.apply(part);
    }
    expect(existsSync(join(homeDir, "attachments/turn-1/photo.png"))).toBe(
      false,
    );
  });

  it("a redelivery restarting at part 1 resets the buffer and still lands", () => {
    const bytes = Buffer.alloc(ATTACHMENT_CHUNK_RAW_BYTES + 5, 3);
    const [p1, p2] = partsFor(bytes);
    const assembler = createAttachmentAssembler(homeDir);
    assembler.apply(p1!); // first delivery dies mid-way
    assembler.apply(p1!); // stale-dispatch redelivery restarts
    assembler.apply(p2!);
    expect(
      readFileSync(join(homeDir, "attachments/turn-1/photo.png")).equals(bytes),
    ).toBe(true);
  });

  it("an out-of-order part drops the whole buffer", () => {
    const bytes = Buffer.alloc(ATTACHMENT_CHUNK_RAW_BYTES * 2, 9);
    const [p1, p2] = partsFor(bytes);
    const assembler = createAttachmentAssembler(homeDir);
    assembler.apply(p2!); // no part 1 first
    assembler.apply(p1!);
    assembler.apply(p2!); // now valid: 1 then 2
    expect(
      readFileSync(join(homeDir, "attachments/turn-1/photo.png")).equals(bytes),
    ).toBe(true);
  });

  it("refuses paths outside the attachments root", () => {
    const bytes = Buffer.from("x");
    const assembler = createAttachmentAssembler(homeDir);
    for (const part of partsFor(bytes, { path: "memory/evil.md" })) {
      assembler.apply(part);
    }
    expect(existsSync(join(homeDir, "memory/evil.md"))).toBe(false);
  });

  it("replaces a planted symlink parent instead of following it", () => {
    // The agent plants attachments/turn-1 -> /tmp/elsewhere before delivery.
    const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
    mkdirSync(join(homeDir, "attachments"));
    symlinkSync(elsewhere, join(homeDir, "attachments/turn-1"));

    const bytes = Buffer.from("safe bytes");
    const assembler = createAttachmentAssembler(homeDir);
    for (const part of partsFor(bytes)) assembler.apply(part);

    const parent = lstatSync(join(homeDir, "attachments/turn-1"));
    expect(parent.isSymbolicLink()).toBe(false);
    expect(existsSync(join(elsewhere, "photo.png"))).toBe(false);
    expect(
      readFileSync(join(homeDir, "attachments/turn-1/photo.png")).equals(bytes),
    ).toBe(true);
  });
});

describe("readMaterializedAttachment", () => {
  it("reads back exactly what was materialized", () => {
    const bytes = Buffer.from("image bytes");
    const assembler = createAttachmentAssembler(homeDir);
    for (const part of partsFor(bytes)) assembler.apply(part);
    const read = readMaterializedAttachment(
      homeDir,
      "attachments/turn-1/photo.png",
      { sizeBytes: bytes.byteLength, sha256: sha(bytes) },
    );
    expect(read?.equals(bytes)).toBe(true);
  });

  it("refuses a swapped file (size or hash drift) and symlinks", () => {
    const bytes = Buffer.from("original");
    const assembler = createAttachmentAssembler(homeDir);
    for (const part of partsFor(bytes)) assembler.apply(part);
    expect(
      readMaterializedAttachment(homeDir, "attachments/turn-1/photo.png", {
        sizeBytes: bytes.byteLength,
        sha256: "0".repeat(64),
      }),
    ).toBeNull();
    expect(
      readMaterializedAttachment(homeDir, "memory/whatever.md", {
        sizeBytes: 1,
        sha256: sha(Buffer.from("x")),
      }),
    ).toBeNull();
  });
});

describe("pruneStaleAttachments", () => {
  it("removes old turn dirs, keeps fresh ones, unlinks planted links", () => {
    const root = join(homeDir, "attachments");
    mkdirSync(root);
    mkdirSync(join(root, "old-turn"));
    writeFileSync(join(root, "old-turn/f.txt"), "x");
    const oldSeconds = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(join(root, "old-turn"), oldSeconds, oldSeconds);
    mkdirSync(join(root, "fresh-turn"));
    const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
    symlinkSync(elsewhere, join(root, "planted"));

    pruneStaleAttachments(homeDir);

    expect(existsSync(join(root, "old-turn"))).toBe(false);
    expect(existsSync(join(root, "fresh-turn"))).toBe(true);
    expect(existsSync(join(root, "planted"))).toBe(false);
    expect(existsSync(elsewhere)).toBe(true); // the TARGET survives
  });
});
