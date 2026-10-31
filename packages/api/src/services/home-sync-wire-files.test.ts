import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_SYNC_PART_BYTES,
  SYNC_FILE_CHUNK_RAW_BYTES,
  runnerWorkItemSchema,
  syncFrameByteLength,
} from "@onecli/agent-protocol";
import { packSyncParts, wireFileOf } from "./home-sync-service";

vi.mock("@onecli/db", () => ({ db: {}, Prisma: {} }));

const SKILL = ".agents/skills/s";
const extras = (prune: string[]) => ({
  prune,
  instructions: "",
  agentName: "",
  channels: [],
  peers: [],
  connections: [],
});

const blobsOf = (path: string, file: Parameters<typeof wireFileOf>[0]) =>
  wireFileOf({ ...file, path }).items.map(({ item }) => {
    if (item.kind !== "blob") throw new Error("expected a blob");
    return item.blob;
  });

describe("wireFileOf", () => {
  it("leaves plain text files exactly as before", () => {
    expect(
      wireFileOf({ path: `${SKILL}/a.md`, content: "hi" }).items.map(
        ({ item }) => item,
      ),
    ).toEqual([
      { kind: "file", file: { path: `${SKILL}/a.md`, content: "hi" } },
    ]);
  });

  it("keeps runnable text as a file and sends binary as a blob", () => {
    const bin = new Uint8Array([0, 1, 2, 255]);
    expect(
      wireFileOf({
        path: `${SKILL}/run`,
        content: "#!/bin/sh\n",
        executable: true,
      }).items.map(({ item }) => item),
    ).toEqual([
      {
        kind: "file",
        file: {
          path: `${SKILL}/run`,
          content: "#!/bin/sh\n",
          executable: true,
        },
      },
    ]);
    expect(
      blobsOf(`${SKILL}/x.png`, { path: "", content: "", data: bin }),
    ).toEqual([
      {
        path: `${SKILL}/x.png`,
        dataBase64: Buffer.from(bin).toString("base64"),
      },
    ]);
  });

  it("measures each item exactly as it serializes", () => {
    const { items } = wireFileOf({ path: `${SKILL}/q.md`, content: 'é\n"' });
    for (const { item, bytes } of items) {
      expect(bytes).toBe(
        syncFrameByteLength(item.kind === "file" ? item.file : item.blob),
      );
    }
  });

  it("sends skill text too escape-dense for a frame as a blob rather than drop it", () => {
    // Control characters escape to six JSON bytes apiece: as text this one
    // file outgrows a frame, as base64 it fits a single blob.
    const text = "\u0001".repeat(60_000);
    const blobs = blobsOf(`${SKILL}/ctl.txt`, { path: "", content: text });
    expect(blobs).toHaveLength(1);
    expect(Buffer.from(blobs[0]?.dataBase64 ?? "", "base64").toString()).toBe(
      text,
    );
  });

  it("never turns a memory file into a blob", () => {
    const { items } = wireFileOf({
      path: "memory/index.md",
      content: "\u0001".repeat(10),
    });
    expect(items.map(({ item }) => item.kind)).toEqual(["file"]);
  });

  it("splits a big file into frame-sized chunks that rebuild byte-exact", () => {
    const text = "x".repeat(SYNC_FILE_CHUNK_RAW_BYTES * 2 + 10);
    const blobs = blobsOf(`${SKILL}/logs.json`, { path: "", content: text });
    expect(blobs).toHaveLength(3);
    const sha = createHash("sha256").update(text).digest("hex");
    blobs.forEach((blob, i) => {
      expect(blob.chunk).toEqual({ index: i + 1, of: 3, sha256: sha });
      expect(syncFrameByteLength({ files: [], blobs: [blob] })).toBeLessThan(
        MAX_SYNC_PART_BYTES,
      );
    });
    const rebuilt = Buffer.concat(
      blobs.map((b) => Buffer.from(b.dataBase64, "base64")),
    ).toString("utf8");
    expect(rebuilt).toBe(text);
  });
});

describe("packSyncParts with blobs", () => {
  it("packs blobs into their own list, every part within the frame and the wire", () => {
    const big = new Uint8Array(SYNC_FILE_CHUNK_RAW_BYTES * 3).fill(9);
    const files = [
      { path: `${SKILL}/SKILL.md`, content: "# s\n" },
      { path: `${SKILL}/data.bin`, content: "", data: big },
    ];
    const parts = packSyncParts({
      agentId: "a",
      files,
      finalExtras: extras(files.map((f) => f.path)),
      generation: 1,
    });
    if (!parts) throw new Error("refused");
    expect(parts.flatMap((p) => p.files.map((f) => f.path))).toEqual([
      `${SKILL}/SKILL.md`,
    ]);
    expect(parts.flatMap((p) => (p.blobs ?? []).map((b) => b.path))).toEqual(
      Array(3).fill(`${SKILL}/data.bin`),
    );
    expect(() =>
      runnerWorkItemSchema.parse({
        kind: "skills.changed",
        sandboxId: "sb",
        generation: 1,
        parts,
      }),
    ).not.toThrow();
  });

  it("past the part cap, prunes only to files that shipped whole", () => {
    // A 3-chunk file across the cut: some chunks ship, the file doesn't
    // land, so it must not be in the manifest either.
    const big = new Uint8Array(SYNC_FILE_CHUNK_RAW_BYTES * 3).fill(7);
    const files = [
      { path: `${SKILL}/a.md`, content: "a" },
      { path: `${SKILL}/b.bin`, content: "", data: big },
    ];
    const parts = packSyncParts({
      agentId: "a",
      files,
      finalExtras: extras(files.map((f) => f.path)),
      generation: 1,
      budget: { maxParts: 3, maxBytes: MAX_SYNC_PART_BYTES },
    });
    if (!parts) throw new Error("refused");
    expect(parts).toHaveLength(3);
    expect(parts.some((p) => (p.blobs ?? []).length > 0)).toBe(true);
    expect(parts.at(-1)?.prune).toEqual([`${SKILL}/a.md`]);
  });
});
