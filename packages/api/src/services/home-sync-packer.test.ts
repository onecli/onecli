import {
  MAX_SYNC_PART_BYTES,
  syncFrameByteLength,
} from "@onecli/agent-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  LIBRARY_MANIFEST_BUDGET_BYTES,
  fitLibraryToSync,
  libraryManifestBytes,
  packSyncParts,
  type SyncFinalExtras,
} from "./home-sync-service";

/**
 * The part packer's laws on a tiny injected budget: the truncation rule
 * (truncate, never refuse, and narrow the prune manifest to exactly what
 * shipped) does not depend on the production wire caps, so it is proven
 * here without production-sized content. home-sync.pg.test.ts keeps the
 * end-to-end composition over real rows.
 */

vi.mock("@onecli/db", () => ({ db: {}, Prisma: {} }));

const BUDGET = { maxParts: 4, maxBytes: 2_048 };

const filesOf = (count: number, size: number) =>
  Array.from({ length: count }, (_, i) => ({
    path: `skills/f-${String(i).padStart(2, "0")}/SKILL.md`,
    content: "x".repeat(size),
  }));

const extrasFor = (paths: string[]): SyncFinalExtras => ({
  prune: paths,
  instructions: "",
  agentName: "",
  channels: [],
  peers: [],
  connections: [],
});

const pack = (files: ReturnType<typeof filesOf>) =>
  packSyncParts({
    agentId: "agent",
    files,
    finalExtras: extrasFor(files.map((f) => f.path)),
    generation: 3,
    budget: BUDGET,
  });

const frameBytes = (
  parts: NonNullable<ReturnType<typeof pack>>,
  index: number,
) =>
  syncFrameByteLength({
    kind: "skills.changed",
    generation: 3,
    part: index + 1,
    of: parts.length,
    ...parts[index],
  });

describe("packSyncParts", () => {
  it("packs small files together and appends the extras part last", () => {
    const files = filesOf(3, 10);
    const parts = pack(files);
    if (!parts) throw new Error("refused");
    expect(parts).toHaveLength(2);
    expect(parts[0]?.files.map((f) => f.path)).toEqual(
      files.map((f) => f.path),
    );
    expect(parts[1]?.files).toEqual([]);
    expect(parts[1]?.prune).toEqual(files.map((f) => f.path));
  });

  it("past the part cap it TRUNCATES — never refuses — and prunes only to what shipped", () => {
    // Each file nearly fills a frame, so every file needs its own part.
    const files = filesOf(BUDGET.maxParts + 6, 1_200);
    const parts = pack(files);
    if (!parts) throw new Error("refused");
    expect(parts).toHaveLength(BUDGET.maxParts);

    // Every part still fits the budget, and the manifest names exactly the
    // files that shipped: a wider manifest would prune nothing, a narrower
    // one would delete files we just wrote.
    for (let i = 0; i < parts.length; i += 1) {
      expect(frameBytes(parts, i)).toBeLessThanOrEqual(BUDGET.maxBytes);
    }
    const shipped = parts.flatMap((part) => part.files.map((f) => f.path));
    expect(shipped).toEqual(
      files.slice(0, BUDGET.maxParts - 1).map((f) => f.path),
    );
    expect(parts.at(-1)?.prune).toEqual(shipped);
  });

  it("skips a single file that cannot fit even alone", () => {
    const files = [...filesOf(1, 10), ...filesOf(2, 5_000).slice(1)];
    const parts = pack(files);
    if (!parts) throw new Error("refused");
    expect(parts.flatMap((p) => p.files.map((f) => f.path))).toEqual([
      files[0]?.path,
    ]);
  });
});

describe("fitLibraryToSync", () => {
  const libFiles = (name: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      path: `.agents/skills/${name}/${i === 0 ? "SKILL.md" : `r/${"x".repeat(100)}${i}.md`}`,
      content: "c",
    }));
  const lib = (...names: string[]) =>
    names.map((name) => ({ name, shadows: [] }));
  const extras = (brief: number): Omit<SyncFinalExtras, "prune"> => ({
    instructions: "i".repeat(brief),
    agentName: "a",
    channels: [],
    peers: [],
    connections: [],
  });
  const finalBytes = (
    files: { path: string }[],
    brief: number,
    maxBytes: number,
  ) =>
    syncFrameByteLength({
      kind: "skills.changed",
      generation: 3,
      part: 4,
      of: 4,
      files: [],
      ...extras(brief),
      prune: files.map((f) => f.path),
    }) <= maxBytes;

  it("keeps everything when the final part fits", () => {
    const files = [...libFiles("alpha", 5), ...libFiles("beta", 5)];
    expect(
      fitLibraryToSync({
        agentId: "agent",
        files,
        library: lib("alpha", "beta"),
        extras: extras(10),
        generation: 3,
        budget: BUDGET,
      }),
    ).toEqual(files);
  });

  it("leaves library skills out (last by name first) until the final part fits; never authored files", () => {
    const authored = [{ path: ".agents/skills/mine/SKILL.md", content: "c" }];
    const files = [
      ...authored,
      ...libFiles("alpha", 6),
      ...libFiles("beta", 6),
    ];
    // 2,048-byte frames: the brief alone takes ~1 KB, so both library skills
    // (~650 bytes of manifest each) can't fit beside it.
    const kept = fitLibraryToSync({
      agentId: "agent",
      files,
      library: lib("alpha", "beta"),
      extras: extras(1_000),
      generation: 3,
      budget: BUDGET,
    });
    expect(finalBytes(kept, 1_000, BUDGET.maxBytes)).toBe(true);
    expect(kept).toEqual(expect.arrayContaining(authored));
    // beta (last by name) goes first; alpha still fits and stays.
    expect(kept.some((f) => f.path.includes("/beta/"))).toBe(false);
    expect(kept.some((f) => f.path.includes("/alpha/"))).toBe(true);
  });

  it("leaves library skills out until the file parts fit the part cap, so truncation never reaches memory", () => {
    // Each library file needs a part of its own (four, past the three file
    // parts a 4-part budget leaves); memory sorts after skills, so a
    // truncating packer would drop it first.
    const big = (name: string) => ({
      path: `.agents/skills/${name}/SKILL.md`,
      content: "x".repeat(1_500),
    });
    const memory = { path: "memory/index.md", content: "m" };
    const files = [
      big("alpha"),
      big("beta"),
      big("delta"),
      big("gamma"),
      memory,
    ];
    const kept = fitLibraryToSync({
      agentId: "agent",
      files,
      library: lib("alpha", "beta", "delta", "gamma"),
      extras: extras(10),
      generation: 3,
      budget: BUDGET,
    });
    const parts = packSyncParts({
      agentId: "agent",
      files: kept,
      finalExtras: { ...extras(10), prune: kept.map((f) => f.path) },
      generation: 3,
      budget: BUDGET,
    });
    if (!parts) throw new Error("refused");
    expect(parts.length).toBeLessThanOrEqual(BUDGET.maxParts);
    expect(parts.at(-1)?.prune).toContain("memory/index.md");
    expect(kept.some((f) => f.path.includes("/gamma/"))).toBe(false);
  });

  it("a left-out library skill gives its name back to the agent's own skill", () => {
    const own = { path: ".agents/skills/beta/SKILL.md", content: "MINE" };
    const files = [...libFiles("alpha", 6), ...libFiles("beta", 6)];
    const kept = fitLibraryToSync({
      agentId: "agent",
      files,
      library: [
        { name: "alpha", shadows: [] },
        { name: "beta", shadows: [own] },
      ],
      extras: extras(1_000),
      generation: 3,
      budget: BUDGET,
    });
    expect(kept).toContainEqual(own);
    expect(kept.map((f) => f.path)).toEqual(
      [...kept.map((f) => f.path)].sort(),
    );
  });
});

describe("packSyncParts sizing", () => {
  it("packs each part exactly to the frame: no part over, and no two adjacent parts that would have fit as one", () => {
    const files = Array.from({ length: 40 }, (_, i) => ({
      path: `.agents/skills/s/${String(i).padStart(2, "0")}.md`,
      content: 'é\n"'.repeat(30 + ((i * 37) % 90)),
    }));
    const parts = pack(files);
    if (!parts) throw new Error("refused");
    const fileParts = parts.slice(0, -1);
    for (let i = 0; i < parts.length; i += 1) {
      expect(frameBytes(parts, i)).toBeLessThanOrEqual(BUDGET.maxBytes);
    }
    // Greedy and tight: each part's next file would not have fit in it.
    for (let i = 0; i + 1 < fileParts.length; i += 1) {
      const grown = {
        files: [...(fileParts[i]?.files ?? []), fileParts[i + 1]?.files[0]],
      };
      expect(
        syncFrameByteLength({
          kind: "skills.changed",
          generation: 3,
          part: BUDGET.maxParts,
          of: BUDGET.maxParts,
          ...grown,
        }),
      ).toBeGreaterThan(BUDGET.maxBytes);
    }
  });
});

describe("the library's sync budget", () => {
  it("a full library budget's manifest fits a frame beside a typical agent", () => {
    // A library at its budget, plus a typical rest-of-agent (a full brief,
    // a handful of connections and peers): the final part must fit with room
    // to spare. The composer's backstop covers the pathological rest.
    const perSkill = Math.floor(LIBRARY_MANIFEST_BUDGET_BYTES / 50);
    const paths: string[] = [];
    let used = 0;
    for (let i = 0; used < LIBRARY_MANIFEST_BUDGET_BYTES - perSkill; i += 1) {
      const name = `lib-${String(i).padStart(2, "0")}`;
      const path = `references/${"x".repeat(Math.max(1, perSkill - 40))}.md`;
      used += libraryManifestBytes(name, [path]);
      paths.push(`.agents/skills/${name}/${path}`);
    }
    const bytes = syncFrameByteLength({
      kind: "skills.changed",
      generation: 2_147_483_647,
      part: 256,
      of: 256,
      files: [],
      instructions: "i".repeat(20_000),
      agentName: "a".repeat(80),
      channels: [],
      peers: Array.from({ length: 10 }, (_, i) => ({ name: `peer ${i}` })),
      connections: [],
      prune: paths,
    });
    expect(bytes).toBeLessThan(MAX_SYNC_PART_BYTES * 0.5);
  });
});
