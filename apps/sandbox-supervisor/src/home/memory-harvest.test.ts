import { execSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  renderMemoryFile,
  type SupervisorMessage,
  type WorkItem,
} from "@onecli/agent-protocol";
import {
  createMemoryHarvester,
  memoryKeyOfFileName,
  type MemoryHarvester,
} from "./memory-harvest";

/**
 * The harvester against a real tmpdir: the self-authenticating skip
 * (pristine projections NEVER upload), upload settlement, refusal/retry
 * pacing, and the reader-hardening laws (symlink/FIFO/bad-name/oversize).
 */

type WriteFrame = Extract<SupervisorMessage, { kind: "memory.write" }>;

let home: string;
let memoryDir: string;
let sent: WriteFrame[];
let harvester: MemoryHarvester;

const create = (
  overrides: Partial<{
    intervalMs: number;
    timeoutMs: number;
    retryMs: number;
    activeTurn: () => { conversationId: string; turnId: string } | null;
  }> = {},
) =>
  createMemoryHarvester({
    homeDir: home,
    send: (message) => {
      if (message.kind === "memory.write") sent.push(message);
    },
    activeTurn: overrides.activeTurn ?? (() => null),
    intervalMs: overrides.intervalMs ?? 60_000, // tests drive poll() directly
    timeoutMs: overrides.timeoutMs ?? 1_000,
    retryMs: overrides.retryMs ?? 50,
  });

type WriteResult = Extract<WorkItem, { kind: "memory.write.result" }>;

/** Drive one pass, answering every write it sends with `result`. */
const pollAnswering = async (
  result: (frame: WriteFrame) => Partial<Omit<WriteResult, "kind" | "writeId">>,
): Promise<void> => {
  const done = harvester.poll();
  // Answer frames as they appear until the pass settles.
  const answering = (async () => {
    const answered = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      for (const frame of sent) {
        if (answered.has(frame.writeId)) continue;
        answered.add(frame.writeId);
        harvester.handleResult({
          kind: "memory.write.result",
          writeId: frame.writeId,
          ok: true,
          ...result(frame),
        });
      }
      const settled = await Promise.race([
        done.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 5)),
      ]);
      if (settled) return;
    }
  })();
  await done;
  await answering;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "harvest-ws-"));
  memoryDir = join(home, "memory");
  mkdirSync(memoryDir);
  sent = [];
  harvester = create();
});

afterEach(() => {
  harvester.stop();
});

describe("memoryKeyOfFileName", () => {
  it("maps valid names and refuses everything else", () => {
    expect(memoryKeyOfFileName("deploy-notes.md")).toBe("deploy-notes");
    expect(memoryKeyOfFileName("index.md")).toBeNull();
    expect(memoryKeyOfFileName("Not-Valid.md")).toBeNull();
    expect(memoryKeyOfFileName("notes.txt")).toBeNull();
    expect(memoryKeyOfFileName("has space.md")).toBeNull();
    expect(memoryKeyOfFileName(`${"k".repeat(81)}.md`)).toBeNull();
  });
});

describe("the self-authenticating skip", () => {
  it("an unmodified projection NEVER uploads", async () => {
    // MUTATION-PROOF: blank the isUnmodifiedProjection check and this fails
    // — every boot would re-upload the whole memory set (and a stale
    // projection could revert a newer dashboard edit).
    writeFileSync(
      join(memoryDir, "fact.md"),
      renderMemoryFile({
        key: "fact",
        title: "T",
        description: null,
        content: "body",
      }),
    );
    await harvester.poll();
    expect(sent).toEqual([]);
  });

  it("harvestFile reports pristine for it (the prune gate's delete signal)", async () => {
    writeFileSync(
      join(memoryDir, "fact.md"),
      renderMemoryFile({
        key: "fact",
        title: null,
        description: null,
        content: "body",
      }),
    );
    await expect(harvester.harvestFile("fact.md")).resolves.toBe("pristine");
  });
});

describe("uploads", () => {
  it("uploads an agent-authored file with parsed fields and the turn anchor", async () => {
    harvester.stop();
    harvester = create({
      activeTurn: () => ({ conversationId: "cv-1", turnId: "t-1" }),
    });
    writeFileSync(
      join(memoryDir, "my-note.md"),
      "---\ntitle: My Note\n---\nagent body",
    );

    await pollAnswering(() => ({ created: true, revisionSeq: 1 }));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: "memory.write",
      key: "my-note",
      title: "My Note",
      content: "agent body",
      conversationId: "cv-1",
      turnId: "t-1",
    });
  });

  it("a settled upload never re-sends until the content changes", async () => {
    const file = join(memoryDir, "note.md");
    writeFileSync(file, "v1");
    await pollAnswering(() => ({}));
    expect(sent).toHaveLength(1);

    await harvester.poll();
    expect(sent).toHaveLength(1); // unchanged — no re-send

    writeFileSync(file, "v2");
    await pollAnswering(() => ({}));
    expect(sent).toHaveLength(2); // changed — harvested again
  });

  it("clips oversized parsed metadata instead of refusing the memory", async () => {
    writeFileSync(
      join(memoryDir, "note.md"),
      `---\ntitle: ${"t".repeat(500)}\n---\nbody`,
    );
    await pollAnswering(() => ({}));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.title).toHaveLength(120);
  });
});

describe("refusals and retries", () => {
  it("a non-retryable refusal parks the content — re-attempted only on change", async () => {
    const file = join(memoryDir, "note.md");
    writeFileSync(file, "refused body");
    const done = harvester.poll();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    harvester.handleResult({
      kind: "memory.write.result",
      writeId: sent[0]?.writeId ?? "",
      ok: false,
      error: "too large",
    });
    await done;

    await harvester.poll();
    expect(sent).toHaveLength(1); // same bytes — no retry

    writeFileSync(file, "new body");
    const second = harvester.poll();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    harvester.handleResult({
      kind: "memory.write.result",
      writeId: sent[1]?.writeId ?? "",
      ok: true,
    });
    await second;
  });

  it("a retryable refusal re-attempts on the paced clock", async () => {
    writeFileSync(join(memoryDir, "note.md"), "body");
    const done = harvester.poll();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    harvester.handleResult({
      kind: "memory.write.result",
      writeId: sent[0]?.writeId ?? "",
      ok: false,
      retryable: true,
      error: "paced",
    });
    await done;

    await harvester.poll();
    expect(sent).toHaveLength(1); // inside the pacing window

    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = harvester.poll();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    harvester.handleResult({
      kind: "memory.write.result",
      writeId: sent[1]?.writeId ?? "",
      ok: true,
    });
    await second;
  });

  it("a timeout resolves into a paced retry — the chain never wedges", async () => {
    harvester.stop();
    harvester = create({ timeoutMs: 30 });
    writeFileSync(join(memoryDir, "note.md"), "body");
    await expect(harvester.harvestFile("note.md")).resolves.toBe("retry");
  });

  it("an empty file is refused, not uploaded", async () => {
    writeFileSync(join(memoryDir, "empty.md"), "   \n");
    await harvester.poll();
    expect(sent).toEqual([]);
  });
});

describe("the volume ledger (crash unambiguity)", () => {
  it("a NEW harvester over the same home knows what was already uploaded", async () => {
    // MUTATION-PROOF (found live): drop persistLedger/loading and this
    // fails — after a container crash, raw bytes whose canonical render
    // never landed would re-upload at boot, resurrecting a memory a human
    // deleted while the box was down.
    writeFileSync(join(memoryDir, "note.md"), "uploaded once");
    await pollAnswering(() => ({}));
    expect(sent).toHaveLength(1);
    harvester.stop();

    // "The container died and came back": a fresh instance, same volume.
    harvester = create();
    await harvester.poll();
    expect(sent).toHaveLength(1); // ledger hit — no re-upload
    await expect(harvester.harvestFile("note.md")).resolves.toBe("uploaded");
  });

  it("a corrupt ledger degrades to re-uploads, never a crash", async () => {
    mkdirSync(join(home, ".onecli"), { recursive: true });
    writeFileSync(join(home, ".onecli/harvest-uploaded.json"), "{nope");
    harvester.stop();
    harvester = create();
    writeFileSync(join(memoryDir, "note.md"), "body");
    await pollAnswering(() => ({}));
    expect(sent).toHaveLength(1); // uploaded fine despite the bad ledger
  });

  it("forgetFile drops the ledger entry — a byte-identical re-creation re-uploads", async () => {
    // MUTATION-PROOF (lens-2 catch): the materializer calls forgetFile when
    // it prunes a memory file (landed platform delete). Without consuming
    // the entry, a later identical re-creation hits the "already uploaded"
    // skip — swallowed, no RPC — and the prune deletes it again.
    const file = join(memoryDir, "todo.md");
    writeFileSync(file, "remember X");
    await pollAnswering(() => ({}));
    expect(sent).toHaveLength(1);

    harvester.forgetFile("todo.md"); // the prune's landed-delete signal

    // The agent re-creates the identical bytes weeks later.
    writeFileSync(file, "remember X");
    await pollAnswering(() => ({}));
    expect(sent).toHaveLength(2); // a real upload, not a swallow
  });
});

describe("the harvest→clobber race", () => {
  it("a write DURING the upload round-trip returns retry, so the caller never clobbers newer bytes", async () => {
    // MUTATION-PROOF (lens-2 catch): drop the post-upload re-stat and this
    // fails — harvestFile returns "uploaded" for content that no longer
    // matches disk, and the materializer's overwrite/prune then destroys the
    // bytes the agent wrote mid-round-trip (never uploaded).
    const file = join(memoryDir, "notes.md");
    writeFileSync(file, "line 1\n");
    const pending = harvester.harvestFile("notes.md");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    // The agent appends while the upload is in flight.
    writeFileSync(file, "line 1\nline 2\n");
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    harvester.handleResult({
      kind: "memory.write.result",
      writeId: sent[0]?.writeId ?? "",
      ok: true,
      created: true,
    });
    // The platform holds line-1-only, but disk now has line 2 — so NOT safe
    // to clobber: retry (the next pass harvests the newer bytes).
    await expect(pending).resolves.toBe("retry");
  });
});

describe("reader hardening", () => {
  it("never opens a symlink, a FIFO, or a bad name", async () => {
    const target = join(home, "outside.md");
    writeFileSync(target, "outside");
    symlinkSync(target, join(memoryDir, "linked.md"));
    writeFileSync(join(memoryDir, "Not A Key.md"), "kept");
    writeFileSync(join(memoryDir, "notes.txt"), "kept");
    // A planted FIFO must not wedge the pass (the jcode-background law).
    execSync(`mkfifo ${JSON.stringify(join(memoryDir, "wedge.md"))}`);

    await harvester.poll();
    expect(sent).toEqual([]);
  });

  it("index.md is never harvested", async () => {
    writeFileSync(join(memoryDir, "index.md"), "# agent edited the index");
    await harvester.poll();
    expect(sent).toEqual([]);
  });

  it("the stat fast-path still catches a same-size in-place edit via mtime", async () => {
    const file = join(memoryDir, "note.md");
    writeFileSync(file, "aaaa");
    await pollAnswering(() => ({}));
    expect(sent).toHaveLength(1);

    writeFileSync(file, "bbbb"); // same size
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    await pollAnswering(() => ({}));
    expect(sent).toHaveLength(2);
  });
});
