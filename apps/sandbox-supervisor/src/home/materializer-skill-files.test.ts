import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SYNC_FILE_CHUNK_RAW_BYTES,
  type WorkItem,
} from "@onecli/agent-protocol";
import { applyHomeSync } from "./materializer";
import type { RenderInputs } from "./renderer";

/**
 * Folder skills on disk: runnable scripts land 0555, binary files (sent in
 * the separate `blobs` list) land byte-exact, and a file too big for one
 * frame is rebuilt from its chunks only when every chunk arrived in order
 * and the hash matches.
 */

type SyncItem = Extract<WorkItem, { kind: "skills.changed" }>;
type WireBlob = NonNullable<SyncItem["blobs"]>[number];

let home: string;
let inputs: RenderInputs;
const send = (): void => undefined;
const ROOT = ".agents/skills/s";

const item = (
  files: SyncItem["files"],
  extra: Partial<SyncItem> = {},
): SyncItem => ({
  kind: "skills.changed",
  generation: 1,
  part: 1,
  of: 1,
  files,
  prune: files.map((f) => f.path),
  ...extra,
});

const blobItem = (blobs: WireBlob[], extra: Partial<SyncItem> = {}) =>
  item([], { blobs, prune: [...new Set(blobs.map((b) => b.path))], ...extra });

const chunksOf = (path: string, bytes: Buffer): WireBlob[] => {
  const of = Math.ceil(bytes.length / SYNC_FILE_CHUNK_RAW_BYTES);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return Array.from({ length: of }, (_, i) => ({
    path,
    dataBase64: bytes
      .subarray(
        i * SYNC_FILE_CHUNK_RAW_BYTES,
        (i + 1) * SYNC_FILE_CHUNK_RAW_BYTES,
      )
      .toString("base64"),
    chunk: { index: i + 1, of, sha256 },
  }));
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "skill-files-"));
  inputs = {
    instructions: undefined,
    agentName: undefined,
    channels: [],
    peers: [],
    connections: [],
    capabilities: {
      resume: true,
      thinking: false,
      toolEvents: true,
      steer: true,
      backgroundTool: true,
      skillsDir: ".agents/skills",
      instructionFiles: ["CLAUDE.md"],
      platformTools: true,
    },
    fragments: [],
  };
});

describe("folder skills on disk", () => {
  it("writes runnable scripts 0555 and plain files 0444", async () => {
    await applyHomeSync(
      home,
      item([
        {
          path: `${ROOT}/run`,
          content: "#!/bin/sh\necho hi\n",
          executable: true,
        },
        { path: `${ROOT}/playbooks/a.md`, content: "# a\n" },
      ]),
      inputs,
      send,
    );
    expect(statSync(join(home, ROOT, "run")).mode & 0o777).toBe(0o555);
    expect(statSync(join(home, ROOT, "playbooks/a.md")).mode & 0o777).toBe(
      0o444,
    );
    expect(readFileSync(join(home, ROOT, "run"), "utf8")).toBe(
      "#!/bin/sh\necho hi\n",
    );
  });

  it("writes binary blobs byte-exact", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    await applyHomeSync(
      home,
      blobItem([
        { path: `${ROOT}/logo.png`, dataBase64: png.toString("base64") },
      ]),
      inputs,
      send,
    );
    expect(readFileSync(join(home, ROOT, "logo.png")).equals(png)).toBe(true);
  });

  it("refuses a blob aimed outside the skills folder", async () => {
    await applyHomeSync(
      home,
      blobItem([
        {
          path: "memory/notes.md",
          dataBase64: Buffer.from("x").toString("base64"),
        },
      ]),
      inputs,
      send,
    );
    expect(existsSync(join(home, "memory/notes.md"))).toBe(false);
  });

  it("rebuilds a big file from chunks spread over several parts", async () => {
    const big = Buffer.alloc(SYNC_FILE_CHUNK_RAW_BYTES * 2 + 17, 7);
    big[0] = 1;
    const path = `${ROOT}/fixtures/logs.json`;
    const [c1, c2, c3] = chunksOf(path, big);
    await applyHomeSync(
      home,
      blobItem([c1!], { part: 1, of: 3, prune: undefined }),
      inputs,
      send,
    );
    expect(existsSync(join(home, path))).toBe(false);
    await applyHomeSync(
      home,
      blobItem([c2!], { part: 2, of: 3, prune: undefined }),
      inputs,
      send,
    );
    await applyHomeSync(
      home,
      blobItem([c3!], { part: 3, of: 3, prune: [path] }),
      inputs,
      send,
    );
    expect(readFileSync(join(home, path)).equals(big)).toBe(true);
  });

  it("drops a chunked file whose bytes don't match its hash", async () => {
    const big = Buffer.alloc(SYNC_FILE_CHUNK_RAW_BYTES + 5, 3);
    const chunks = chunksOf(`${ROOT}/data.bin`, big);
    chunks[1] = {
      ...chunks[1]!,
      dataBase64: Buffer.from("tampered").toString("base64"),
    };
    await applyHomeSync(home, blobItem(chunks), inputs, send);
    expect(existsSync(join(home, ROOT, "data.bin"))).toBe(false);
  });

  it("drops a chunked file that arrives out of order", async () => {
    const big = Buffer.alloc(SYNC_FILE_CHUNK_RAW_BYTES + 5, 3);
    const [c1, c2] = chunksOf(`${ROOT}/data.bin`, big);
    await applyHomeSync(home, blobItem([c2!, c1!]), inputs, send);
    expect(existsSync(join(home, ROOT, "data.bin"))).toBe(false);
  });
});
