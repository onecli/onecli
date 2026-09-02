import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * The memory FILE-WRITE door on REAL PostgreSQL (the §3.8 write-back
 * amendment). What only pg can prove end-to-end: the two-fact fence
 * (runner + sandbox → derived agent), merge-preserve semantics through the
 * door, the noop echo terminator, the projectability gate on the merged
 * state, the count cap, write pacing, delete+edit resurrection, the
 * generation bump discipline, revision previews vs the full-revision read,
 * and memory_get's clip.
 *
 * Env-gated like the other proof suites; see pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type MemoryService = typeof import("./agent-memory-service");
type PlatformTools = typeof import("./platform-tool-service");

let db: Db;
let memoryService: MemoryService;
let platformTools: PlatformTools;

const P = "mfw-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const RUNNER = `${P}runner`;
const FOREIGN_RUNNER = `${P}runner-x`;
const USER = `${P}user`;

const AUTHOR = {
  authorKind: "user" as const,
  authorUserId: USER,
  authorEmail: `${P}user@example.com`,
  conversationId: null,
  turnId: null,
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  // Pinned per-suite: process.env leaks across worker files, and CI's ambient
  // NEXT_PUBLIC_EDITION is cloud.
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";

  ({ db } = await import("@onecli/db"));
  memoryService = await import("./agent-memory-service");
  platformTools = await import("./platform-tool-service");

  await resetAll();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "File Write Workspace", organizationId: ORG },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await resetAll();
});

const resetAll = async () => {
  await db.agentMemory.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.turn.deleteMany({
    where: { conversation: { agent: { identifier: { startsWith: P } } } },
  });
  await db.conversation.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.sandbox.deleteMany({ where: { id: { startsWith: P } } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
  await db.auditLog.deleteMany({ where: { userId: USER } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

beforeEach(async () => {
  if (!PROOF_URL) return;
  await db.agentMemory.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.turn.deleteMany({
    where: { conversation: { agent: { identifier: { startsWith: P } } } },
  });
  await db.conversation.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.sandbox.deleteMany({ where: { id: { startsWith: P } } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
  await db.auditLog.deleteMany({ where: { userId: USER } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
  await db.user.create({
    data: {
      id: USER,
      email: `${P}user@example.com`,
      name: "File Write User",
      externalAuthId: `${P}auth`,
    },
  });
  await db.runner.create({
    data: { id: RUNNER, name: "runner", token: `rnr_${P}` },
  });
  await db.runner.create({
    data: { id: FOREIGN_RUNNER, name: "runner x", token: `rnr_${P}x` },
  });
  // Pacing state is per-process; a suite must start each test full.
  platformTools.resetMemoryWritePacing();
});

/** A hosted agent WITH its sandbox — the file door's identity is the
 * (runner, sandbox) pair, so every test needs both facts seeded. */
const seedSandboxedAgent = async (suffix: string) => {
  const agent = await db.agent.create({
    data: {
      workspaceId: WORKSPACE,
      name: `agent ${suffix}`,
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind: "hosted",
      harness: "fake",
      sandbox: { create: { id: `${P}sb-${suffix}`, runnerId: RUNNER } },
    },
    select: { id: true },
  });
  return { agentId: agent.id, sandboxId: `${P}sb-${suffix}` };
};

const write = (
  sandboxId: string,
  key: string,
  content: string,
  extra: { title?: string; description?: string } = {},
  runnerId = RUNNER,
) =>
  platformTools.executeMemoryFileWrite(runnerId, {
    sandboxId,
    key,
    content,
    ...extra,
  });

const desiredGeneration = async (sandboxId: string): Promise<number> => {
  const sandbox = await db.sandbox.findUniqueOrThrow({
    where: { id: sandboxId },
    select: { homeDesiredGeneration: true },
  });
  return sandbox.homeDesiredGeneration;
};

describe.skipIf(!PROOF_URL)("the two-fact fence", () => {
  it("a foreign runner's write is a hint-free refusal; the right runner's lands", async () => {
    const { agentId, sandboxId } = await seedSandboxedAgent("fence");

    const refused = await write(
      sandboxId,
      "fact",
      "stolen",
      {},
      FOREIGN_RUNNER,
    );
    expect(refused).toEqual({
      ok: false,
      error: "This write is not available.",
    });
    expect(await db.agentMemory.count({ where: { agentId } })).toBe(0);

    const accepted = await write(sandboxId, "fact", "mine");
    expect(accepted.ok).toBe(true);
    expect(accepted.created).toBe(true);
    expect(await db.agentMemory.count({ where: { agentId } })).toBe(1);
  });

  it("an unknown sandbox is the same hint-free refusal", async () => {
    await seedSandboxedAgent("fence2");
    const refused = await write("no-such-sandbox", "fact", "x");
    expect(refused).toEqual({
      ok: false,
      error: "This write is not available.",
    });
  });
});

describe.skipIf(!PROOF_URL)("save semantics through the door", () => {
  it("creates, then updates by key with MERGE-preserved metadata", async () => {
    const { agentId, sandboxId } = await seedSandboxedAgent("merge");
    const created = await write(sandboxId, "deploy-notes", "v1", {
      title: "Deploy notes",
    });
    expect(created).toMatchObject({ ok: true, created: true, noop: false });

    // Content-only re-write (a file whose frontmatter the agent stripped)
    // must never wipe the human-curated title.
    const updated = await write(sandboxId, "deploy-notes", "v2");
    expect(updated).toMatchObject({ ok: true, created: false, noop: false });
    const head = await db.agentMemory.findFirstOrThrow({
      where: { agentId, key: "deploy-notes" },
    });
    expect(head.content).toBe("v2");
    expect(head.title).toBe("Deploy notes");
    expect(head.lastRevisionSeq).toBe(2);
  });

  it("an equal-state write is a NOOP: no revision, no bump — the echo terminator", async () => {
    // MUTATION-PROOF: route the door around isNoOp and this fails — every
    // projection re-push would mint a revision and re-bump, forever (the
    // echo loop the checksum + noop pair exists to kill).
    const { agentId, sandboxId } = await seedSandboxedAgent("noop");
    await write(sandboxId, "fact", "stable", { title: "T" });
    const generationAfterSave = await desiredGeneration(sandboxId);

    const echoed = await write(sandboxId, "fact", "stable", { title: "T" });
    expect(echoed).toMatchObject({ ok: true, noop: true });
    const head = await db.agentMemory.findFirstOrThrow({
      where: { agentId, key: "fact" },
    });
    expect(head.lastRevisionSeq).toBe(1);
    expect(await desiredGeneration(sandboxId)).toBe(generationAfterSave);
  });

  it("a real change bumps the home generation", async () => {
    const { sandboxId } = await seedSandboxedAgent("bump");
    const before = await desiredGeneration(sandboxId);
    await write(sandboxId, "fact", "v1");
    expect(await desiredGeneration(sandboxId)).toBe(before + 1);
  });

  it("delete + agent file edit resurrects the memory (the decided semantics)", async () => {
    const { agentId, sandboxId } = await seedSandboxedAgent("resurrect");
    await write(sandboxId, "fact", "v1");
    const head = await db.agentMemory.findFirstOrThrow({
      where: { agentId, key: "fact" },
      select: { id: true },
    });
    await memoryService.deleteMemory(WORKSPACE, agentId, head.id);
    expect(await db.agentMemory.count({ where: { agentId } })).toBe(0);

    const rewritten = await write(sandboxId, "fact", "the agent's edit");
    expect(rewritten).toMatchObject({ ok: true, created: true });
    const revived = await db.agentMemory.findFirstOrThrow({
      where: { agentId, key: "fact" },
    });
    expect(revived.content).toBe("the agent's edit");
  });

  it("attribution: agent-authored, via-user only through a VERIFIED turn", async () => {
    const { agentId, sandboxId } = await seedSandboxedAgent("attrib");
    const conversation = await db.conversation.create({
      data: { agentId, title: "t", source: "web" },
      select: { id: true },
    });
    const turn = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "remember it",
        status: "running",
        source: "web",
        userId: USER,
      },
      select: { id: true },
    });

    const result = await platformTools.executeMemoryFileWrite(RUNNER, {
      sandboxId,
      key: "fact",
      content: "body",
      conversationId: conversation.id,
      turnId: turn.id,
    });
    expect(result.ok).toBe(true);

    const revision = await db.agentMemoryRevision.findFirstOrThrow({
      where: { memory: { agentId, key: "fact" } },
    });
    expect(revision.authorKind).toBe("agent");
    expect(revision.authorUserId).toBe(USER);
    expect(revision.authorEmail).toBe(`${P}user@example.com`);
    expect(revision.conversationId).toBe(conversation.id);
    expect(revision.turnId).toBe(turn.id);

    // The via-user write is audited (viaAgent + viaFile).
    const audit = await db.auditLog.findFirst({ where: { userId: USER } });
    expect(audit?.metadata).toMatchObject({
      viaAgent: "true",
      viaFile: "true",
    });
  });

  it("a FORGED turn claim is dropped, never authority — the write still lands", async () => {
    const { agentId, sandboxId } = await seedSandboxedAgent("forge");
    const other = await seedSandboxedAgent("forge-other");
    const foreignConversation = await db.conversation.create({
      data: { agentId: other.agentId, title: "t", source: "web" },
      select: { id: true },
    });

    const result = await platformTools.executeMemoryFileWrite(RUNNER, {
      sandboxId,
      key: "fact",
      content: "body",
      conversationId: foreignConversation.id,
      turnId: "no-such-turn",
    });
    expect(result.ok).toBe(true);

    const revision = await db.agentMemoryRevision.findFirstOrThrow({
      where: { memory: { agentId, key: "fact" } },
    });
    expect(revision.conversationId).toBeNull();
    expect(revision.authorUserId).toBeNull();
  });
});

describe.skipIf(!PROOF_URL)("caps and pacing", () => {
  it("refuses over-chars content non-retryably", async () => {
    const { sandboxId } = await seedSandboxedAgent("chars");
    const result = await write(sandboxId, "big", "x".repeat(100_001));
    expect(result.ok).toBe(false);
    expect(result.retryable).toBeUndefined();
    expect(result.error).toContain("split it into linked memories");
  });

  it("refuses content that passes chars but cannot ride a sync frame (the CJK case)", async () => {
    // MUTATION-PROOF for red-team #6: drop assertProjectable and this
    // fails — the save would land and then be silently skipped by the part
    // packer forever.
    const { sandboxId } = await seedSandboxedAgent("cjk");
    const result = await write(sandboxId, "big", "字".repeat(90_000));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("too large to sync");
  });

  it("the dashboard PATCH door enforces the same frame predicate", async () => {
    const { agentId, sandboxId } = await seedSandboxedAgent("dash-cjk");
    await write(sandboxId, "fact", "small");
    const head = await db.agentMemory.findFirstOrThrow({
      where: { agentId, key: "fact" },
      select: { id: true },
    });
    await expect(
      memoryService.updateMemory(
        WORKSPACE,
        agentId,
        head.id,
        { content: "字".repeat(90_000) },
        AUTHOR,
      ),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("the count cap refuses new keys through the file door too", async () => {
    const { agentId, sandboxId } = await seedSandboxedAgent("count");
    await db.agentMemory.createMany({
      data: Array.from({ length: 100 }, (_, i) => ({
        agentId,
        key: `k-${i}`,
        content: "x",
      })),
    });
    const result = await write(sandboxId, "one-more", "x");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already holds");
  });

  it("pacing: the burst spends, then refusals are RETRYABLE", async () => {
    const { sandboxId } = await seedSandboxedAgent("pace");
    for (let i = 0; i < 20; i += 1) {
      const result = await write(sandboxId, `k-${i}`, "body");
      expect(result.ok).toBe(true);
    }
    const paced = await write(sandboxId, "k-over", "body");
    expect(paced.ok).toBe(false);
    expect(paced.retryable).toBe(true);
  });

  it("pacing is PER-SANDBOX — one sandbox draining its bucket never paces another", async () => {
    // MUTATION-PROOF (lens-1 catch): key the bucket globally/by runner and
    // this fails — a shared bucket is the cross-tenant DoS lever (one
    // looping sandbox starves everyone else's harvests). Drain sandbox A's
    // full burst, then B's first write must still land.
    const a = await seedSandboxedAgent("pace-a");
    const b = await seedSandboxedAgent("pace-b");
    for (let i = 0; i < 20; i += 1) {
      expect((await write(a.sandboxId, `k-${i}`, "body")).ok).toBe(true);
    }
    expect((await write(a.sandboxId, "k-over", "body")).ok).toBe(false);
    // B is untouched by A's exhaustion.
    expect((await write(b.sandboxId, "first", "body")).ok).toBe(true);
  });

  it("pacing runs AFTER the fence — a foreign runner can't drain a victim's bucket", async () => {
    // MUTATION-PROOF (lens-1 catch): move the token take above resolveIdentity
    // and this fails — a foreign rnr_ token spraying the victim's sandboxId
    // would spend the victim's tokens without ever passing the fence. Here a
    // foreign runner floods 25 writes at the victim's sandbox (all refused
    // pre-fence, hint-free), then the victim's own runner still has its full
    // burst.
    const victim = await seedSandboxedAgent("pace-fence");
    for (let i = 0; i < 25; i += 1) {
      const refused = await write(
        victim.sandboxId,
        `k-${i}`,
        "body",
        {},
        FOREIGN_RUNNER,
      );
      expect(refused).toEqual({
        ok: false,
        error: "This write is not available.",
      });
    }
    // The victim's bucket was never touched — a full burst still lands.
    for (let i = 0; i < 20; i += 1) {
      expect((await write(victim.sandboxId, `own-${i}`, "body")).ok).toBe(true);
    }
  });
});

describe.skipIf(!PROOF_URL)("the oversize-read fixes", () => {
  it("memory_get clips a big memory to fit the SERIALIZED result and points at the file", async () => {
    const { sandboxId } = await seedSandboxedAgent("get-clip");
    await write(sandboxId, "big", "x".repeat(60_000));
    const result = await platformTools.executePlatformTool(RUNNER, {
      sandboxId,
      tool: "memory_get",
      args: { key: "big" },
    });
    expect(result.ok).toBe(true);
    const payload = result.result as {
      content: string;
      contentTruncated?: boolean;
      note?: string;
    };
    expect(payload.contentTruncated).toBe(true);
    expect(payload.note).toContain("memory/big.md");
    // The load-bearing property: the whole serialized result fits the bound
    // the runner enforces, so the tool answer is never dropped.
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(64_000);
  });

  it("memory_get clips ESCAPE-DENSE content by serialized size, not chars", async () => {
    // MUTATION-PROOF (lens-1 catch): a char-based clip passes a plain-ASCII
    // memory but ships an over-64k serialized result for quote/backslash/
    // newline-dense content — the runner then drops the whole answer. A
    // memory of pure escapes is the worst case.
    const { sandboxId } = await seedSandboxedAgent("get-escape");
    await write(sandboxId, "dump", '"\\\n'.repeat(20_000)); // 60k chars, ~2x escaped
    const result = await platformTools.executePlatformTool(RUNNER, {
      sandboxId,
      tool: "memory_get",
      args: { key: "dump" },
    });
    expect(result.ok).toBe(true);
    const payload = result.result as { contentTruncated?: boolean };
    expect(payload.contentTruncated).toBe(true);
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(64_000);
  });

  it("revision lists carry previews; the single-revision read is full and fenced", async () => {
    const { agentId, sandboxId } = await seedSandboxedAgent("preview");
    await write(sandboxId, "big", "y".repeat(30_000));
    const head = await db.agentMemory.findFirstOrThrow({
      where: { agentId, key: "big" },
      select: { id: true },
    });

    const previews = await memoryService.listRevisions(
      WORKSPACE,
      agentId,
      head.id,
    );
    expect(previews[0]?.content).toHaveLength(2_000);
    expect(previews[0]?.contentTruncated).toBe(true);

    const full = await memoryService.getRevision(
      WORKSPACE,
      agentId,
      head.id,
      previews[0]?.id ?? "",
    );
    expect(full.content).toHaveLength(30_000);

    // Fence: a revision id under a foreign memory reads as NOT_FOUND.
    const other = await seedSandboxedAgent("preview-other");
    await write(other.sandboxId, "big", "z".repeat(10));
    const otherHead = await db.agentMemory.findFirstOrThrow({
      where: { agentId: other.agentId, key: "big" },
      select: { id: true },
    });
    await expect(
      memoryService.getRevision(
        WORKSPACE,
        other.agentId,
        otherHead.id,
        previews[0]?.id ?? "",
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
