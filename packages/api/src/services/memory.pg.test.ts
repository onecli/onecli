import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * Agent memory on REAL PostgreSQL (step 8). What only pg can prove: the
 * hand-appended CHECKs, the PSL unique under NULLS-DISTINCT semantics, the
 * head-mirrors-highest-seq invariant across every mutation, the upsert race
 * (forced with an uncommitted winner), retention pruning, the FTS ranking +
 * snippet + ILIKE arm, cascade behavior, SetNull attribution with the
 * denormalized email surviving, the tool-dispatch audit split, and the
 * dispatch claim carrying agent_id.
 *
 * Env-gated like the other proof suites; see pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type MemoryService = typeof import("./agent-memory-service");
type TurnContext = typeof import("./turn-context-service");
type PlatformTools = typeof import("./platform-tool-service");
type DueWork = typeof import("./due-work");

let db: Db;
let memoryService: MemoryService;
let turnContext: TurnContext;
let platformTools: PlatformTools;
let dueWork: DueWork;

const P = "mem-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const FOREIGN_ORG = `${P}forg`;
const FOREIGN_WORKSPACE = `${P}fproj`;
const RUNNER_A = `${P}runner-a`;
const USER = `${P}user`;

/** The dashboard author every test uses unless attribution is the subject. */
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
  turnContext = await import("./turn-context-service");
  platformTools = await import("./platform-tool-service");
  dueWork = await import("./due-work");

  await resetAll();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Memory Workspace", organizationId: ORG },
  });
  await db.organization.create({
    data: { id: FOREIGN_ORG, name: FOREIGN_ORG, slug: FOREIGN_ORG },
  });
  await db.workspace.create({
    data: {
      id: FOREIGN_WORKSPACE,
      name: "Foreign Workspace",
      organizationId: FOREIGN_ORG,
    },
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
  await db.turnEvent.deleteMany({
    where: { conversation: { agent: { identifier: { startsWith: P } } } },
  });
  await db.turn.deleteMany({
    where: { conversation: { agent: { identifier: { startsWith: P } } } },
  });
  await db.conversation.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.sandbox.deleteMany({
    where: { OR: [{ id: { startsWith: P } }, { runnerId: RUNNER_A }] },
  });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
  // Audit rows pin their user — clear them before the user can go.
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
  await db.turnEvent.deleteMany({
    where: { conversation: { agent: { identifier: { startsWith: P } } } },
  });
  await db.turn.deleteMany({
    where: { conversation: { agent: { identifier: { startsWith: P } } } },
  });
  await db.conversation.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.sandbox.deleteMany({
    where: { OR: [{ id: { startsWith: P } }, { runnerId: RUNNER_A }] },
  });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
  await db.auditLog.deleteMany({ where: { userId: USER } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
  await db.user.create({
    data: {
      id: USER,
      email: `${P}user@example.com`,
      name: "Memory User",
      externalAuthId: `${P}auth`,
    },
  });
  await db.runner.create({
    data: { id: RUNNER_A, name: "runner a", token: `rnr_${P}a` },
  });
});

const seedAgent = async (
  suffix: string,
  workspaceId = WORKSPACE,
  kind = "hosted",
) => {
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `agent ${suffix}`,
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind,
      ...(kind === "hosted" && { harness: "fake" }),
    },
    select: { id: true },
  });
  return agent.id;
};

const save = (
  agentId: string,
  key: string,
  content: string,
  extra: { title?: string; description?: string } = {},
) =>
  memoryService.upsertMemoryByKey(
    WORKSPACE,
    agentId,
    { key, content, ...extra },
    AUTHOR,
  );

describe.skipIf(!PROOF_URL)("the schema constraints", () => {
  it("one key per agent; the same key on two agents coexists", async () => {
    const a = await seedAgent("uniq-a");
    const b = await seedAgent("uniq-b");
    await db.agentMemory.create({
      data: { agentId: a, key: "shared-key", content: "a's" },
    });
    await db.agentMemory.create({
      data: { agentId: b, key: "shared-key", content: "b's" },
    });
    await expect(
      db.agentMemory.create({
        data: { agentId: a, key: "shared-key", content: "dup" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("a restore names its source, and nothing else may (CHECK, both directions)", async () => {
    const a = await seedAgent("check-restore");
    const memory = await db.agentMemory.create({
      data: { agentId: a, key: "k", content: "x", lastRevisionSeq: 1 },
    });
    const base = {
      memoryId: memory.id,
      content: "x",
      authorKind: "user",
    };
    await expect(
      db.agentMemoryRevision.create({
        data: { ...base, seq: 2, op: "save", restoredFromSeq: 1 },
      }),
    ).rejects.toThrow(/agent_memory_revisions_restore_coherent/);
    await expect(
      db.agentMemoryRevision.create({
        data: { ...base, seq: 3, op: "restore", restoredFromSeq: null },
      }),
    ).rejects.toThrow(/agent_memory_revisions_restore_coherent/);
  });

  it("a redactor stamp implies a redaction time — one-way on purpose", async () => {
    const a = await seedAgent("check-redact");
    const memory = await db.agentMemory.create({
      data: { agentId: a, key: "k", content: "x", lastRevisionSeq: 1 },
    });
    await expect(
      db.agentMemoryRevision.create({
        data: {
          memoryId: memory.id,
          seq: 2,
          op: "save",
          content: "x",
          authorKind: "user",
          redactedByUserId: USER,
          redactedAt: null,
        },
      }),
    ).rejects.toThrow(/agent_memory_revisions_redaction_coherent/);
    // The reverse is LEGAL: redactedAt without a redactor is what a deleted
    // user leaves behind (SetNull).
    await db.agentMemoryRevision.create({
      data: {
        memoryId: memory.id,
        seq: 2,
        op: "save",
        content: "x",
        authorKind: "user",
        redactedAt: new Date(),
        redactedByUserId: null,
      },
    });
  });
});

describe.skipIf(!PROOF_URL)("the revision machinery", () => {
  it("head always mirrors the highest-seq snapshot, across save/edit/restore", async () => {
    const a = await seedAgent("mirror");
    await save(a, "fact", "v1", { title: "Fact" });
    await save(a, "fact", "v2");
    const memory = await db.agentMemory.findFirstOrThrow({
      where: { agentId: a, key: "fact" },
      include: { revisions: { orderBy: { seq: "desc" } } },
    });
    expect(memory.lastRevisionSeq).toBe(2);
    expect(memory.revisions).toHaveLength(2);
    // Revision 2 is the head, exactly — and the omitted title was PRESERVED
    // (merge semantics: an agent re-saving content alone must never wipe a
    // human's dashboard curation).
    expect(memory.content).toBe("v2");
    expect(memory.title).toBe("Fact");
    expect(memory.revisions[0]).toMatchObject({
      seq: 2,
      op: "save",
      content: "v2",
      title: "Fact",
    });
    expect(memory.revisions[1]).toMatchObject({ seq: 1, content: "v1" });
  });

  it("restore copies an old snapshot forward and says so; the two refusals hold", async () => {
    const a = await seedAgent("restore");
    await save(a, "fact", "v1");
    const { memory } = await save(a, "fact", "v2");
    const revisions = await memoryService.listRevisions(
      WORKSPACE,
      a,
      memory.id,
    );
    const oldRev = revisions.find((r) => r.seq === 1);
    const latest = revisions.find((r) => r.seq === 2);

    await expect(
      memoryService.restoreRevision(
        WORKSPACE,
        a,
        memory.id,
        latest!.id,
        AUTHOR,
      ),
    ).rejects.toThrow("already the current version");

    const restored = await memoryService.restoreRevision(
      WORKSPACE,
      a,
      memory.id,
      oldRev!.id,
      AUTHOR,
    );
    expect(restored.content).toBe("v1");
    expect(restored.lastRevisionSeq).toBe(3);
    const afterRestore = await memoryService.listRevisions(
      WORKSPACE,
      a,
      memory.id,
    );
    expect(afterRestore[0]).toMatchObject({
      seq: 3,
      op: "restore",
      restoredFromSeq: 1,
      content: "v1",
    });
  });

  it("redact scrubs ONE old snapshot in place; latest and double-redact refuse; restore-from-redacted refuses", async () => {
    const a = await seedAgent("redact");
    await save(a, "leak", "the secret is hunter2");
    const { memory } = await save(a, "leak", "cleaned");
    const revisions = await memoryService.listRevisions(
      WORKSPACE,
      a,
      memory.id,
    );
    const oldRev = revisions.find((r) => r.seq === 1)!;
    const latest = revisions.find((r) => r.seq === 2)!;

    await expect(
      memoryService.redactRevision(WORKSPACE, a, memory.id, latest.id, USER),
    ).rejects.toThrow("edit or delete the memory first");

    const scrubbed = await memoryService.redactRevision(
      WORKSPACE,
      a,
      memory.id,
      oldRev.id,
      USER,
    );
    expect(scrubbed.content).toBe("[redacted]");
    expect(scrubbed.title).toBeNull();
    expect(scrubbed.redactedAt).not.toBeNull();
    expect(scrubbed.redactedByUserId).toBe(USER);
    // Author/op/time metadata survive — they are not the secret.
    expect(scrubbed.op).toBe("save");
    expect(scrubbed.authorUserId).toBe(USER);

    // The head never felt it.
    const head = await memoryService.getMemory(WORKSPACE, a, memory.id);
    expect(head.content).toBe("cleaned");

    await expect(
      memoryService.redactRevision(WORKSPACE, a, memory.id, oldRev.id, USER),
    ).rejects.toThrow("Already redacted");
    await expect(
      memoryService.restoreRevision(WORKSPACE, a, memory.id, oldRev.id, AUTHOR),
    ).rejects.toThrow("its content is gone");
  });

  it("a write that changes nothing appends nothing — either door", async () => {
    const a = await seedAgent("noop");
    const first = await save(a, "fact", "same", { description: "d" });
    expect(first.created).toBe(true);
    const again = await save(a, "fact", "same", { description: "d" });
    expect(again.created).toBe(false);
    expect(again.memory.lastRevisionSeq).toBe(1);

    const patched = await memoryService.updateMemory(
      WORKSPACE,
      a,
      first.memory.id,
      { content: "same" },
      AUTHOR,
    );
    expect(patched.lastRevisionSeq).toBe(1);
  });

  it("retention keeps the newest 50 and the seq keeps counting", async () => {
    const a = await seedAgent("prune");
    const { memory } = await save(a, "fact", "v1");
    for (let i = 2; i <= 52; i += 1) {
      await memoryService.updateMemory(
        WORKSPACE,
        a,
        memory.id,
        { content: `v${i}` },
        AUTHOR,
      );
    }
    const revisions = await memoryService.listRevisions(
      WORKSPACE,
      a,
      memory.id,
    );
    expect(revisions).toHaveLength(50);
    expect(revisions[0]?.seq).toBe(52);
    expect(revisions.at(-1)?.seq).toBe(3);
    const head = await db.agentMemory.findFirstOrThrow({
      where: { id: memory.id },
      select: { lastRevisionSeq: true, content: true },
    });
    expect(head.lastRevisionSeq).toBe(52);
    expect(head.content).toBe("v52");
  });

  it("the upsert race loser lands as an update — forced with an uncommitted winner", async () => {
    const a = await seedAgent("race");
    let releaseWinner: (() => void) | undefined;
    const winnerHolds = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    let signalInserted: (() => void) | undefined;
    const winnerInserted = new Promise<void>((resolve) => {
      signalInserted = resolve;
    });
    // The winner: creates the row inside an OPEN transaction, SIGNALS that
    // the insert has executed (so the ordering is deterministic, never
    // sleep-based), then holds.
    const winner = db.$transaction(async (tx) => {
      const created = await tx.agentMemory.create({
        data: {
          agentId: a,
          key: "contested",
          content: "winner",
          lastRevisionSeq: 1,
        },
        select: { id: true },
      });
      await tx.agentMemoryRevision.create({
        data: {
          memoryId: created.id,
          seq: 1,
          op: "save",
          content: "winner",
          authorKind: "user",
        },
      });
      signalInserted?.();
      await winnerHolds;
    });

    await winnerInserted;

    // The loser: find-misses (uncommitted row invisible), tries to create,
    // BLOCKS on the unique conflict until the winner commits, gets P2002,
    // re-reads, and lands as an update. Release the winner once the loser is
    // definitely in flight — its create cannot complete before the commit.
    const loserPromise = save(a, "contested", "loser");
    setTimeout(() => releaseWinner?.(), 150);
    const [loser] = await Promise.all([loserPromise, winner]);

    expect(loser.created).toBe(false);
    expect(loser.memory.content).toBe("loser");
    expect(loser.memory.lastRevisionSeq).toBe(2);
    const revisions = await db.agentMemoryRevision.findMany({
      where: { memoryId: loser.memory.id },
      orderBy: { seq: "asc" },
    });
    expect(revisions.map((r) => r.content)).toEqual(["winner", "loser"]);
  });
});

describe.skipIf(!PROOF_URL)("the caps", () => {
  it("the 101st memory is refused with the instructive words; updating an existing key still works at the cap", async () => {
    const a = await seedAgent("cap");
    await db.agentMemory.createMany({
      data: Array.from({ length: 100 }, (_, i) => ({
        agentId: a,
        key: `k-${i}`,
        content: "x",
        lastRevisionSeq: 1,
      })),
    });
    await expect(save(a, "one-more", "x")).rejects.toThrow(
      "already holds 100 memories",
    );
    // The cap bounds creation, never correction.
    const updated = await save(a, "k-7", "updated");
    expect(updated.created).toBe(false);
    expect(updated.memory.content).toBe("updated");
  });
});

describe.skipIf(!PROOF_URL)("the fences", () => {
  it("cross-workspace and cross-agent misses are hint-free NOT_FOUNDs", async () => {
    const a = await seedAgent("fence-a");
    const foreign = await seedAgent("fence-f", FOREIGN_WORKSPACE);
    const { memory } = await save(a, "private", "a's fact");

    // The foreign workspace cannot even resolve the agent.
    await expect(
      memoryService.getMemory(FOREIGN_WORKSPACE, a, memory.id),
    ).rejects.toThrow("Agent not found");
    // A right-workspace sibling agent cannot resolve the memory.
    const sibling = await seedAgent("fence-b");
    await expect(
      memoryService.getMemory(WORKSPACE, sibling, memory.id),
    ).rejects.toThrow("Memory not found");
    // And the foreign agent path is fenced before the memory is consulted.
    await expect(
      memoryService.getMemory(WORKSPACE, foreign, memory.id),
    ).rejects.toThrow("Agent not found");
  });

  it("a BYO agent has no memory surface", async () => {
    const byo = await seedAgent("fence-byo", WORKSPACE, "byo");
    await expect(memoryService.listMemories(WORKSPACE, byo)).rejects.toThrow(
      "Only hosted agents have memory",
    );
  });

  it("list, search, get-by-key, and the turn index never leak a sibling's rows", async () => {
    const a = await seedAgent("iso-a");
    const b = await seedAgent("iso-b");
    await save(a, "a-only", "alpha deploys from ci");
    await save(b, "b-only", "beta deploys from cd");

    const listed = await memoryService.listMemories(WORKSPACE, a);
    expect(listed.map((m) => m.key)).toEqual(["a-only"]);

    const hits = await memoryService.searchMemories(a, "deploys");
    expect(hits.map((h) => h.key)).toEqual(["a-only"]);

    await expect(
      memoryService.getMemoryByKey(WORKSPACE, a, "b-only"),
    ).rejects.toThrow('No memory named "b-only"');

    // No real turn here (this asserts the memory index's isolation): a
    // non-existent turnId means the human-only bridge is simply skipped, so
    // the context is memory-only — exactly what we're checking.
    const context = await turnContext.buildTurnContext(
      a,
      "conv-none",
      "turn-none",
      "hello",
    );
    expect(context).toContain("a-only");
    expect(context).not.toContain("b-only");
  });
});

describe.skipIf(!PROOF_URL)("the search", () => {
  it("ranks key/title matches above content-only, stems, snippets, and honors the limit", async () => {
    const a = await seedAgent("search");
    await save(a, "deploy-notes", "How the api ships to production.", {
      title: "Deploying",
    });
    await save(a, "team-lunch", "We usually deploy hunger at noon.", {
      title: "Lunch",
    });
    await save(a, "unrelated", "Nothing to see here.");

    const hits = await memoryService.searchMemories(a, "deploying");
    // Stemming: "deploying" finds both "deploy" rows; the key/title match
    // outranks the content-only one.
    expect(hits.map((h) => h.key)).toEqual(["deploy-notes", "team-lunch"]);
    expect(hits[0]!.rank).toBeGreaterThan(hits[1]!.rank);
    expect(hits[0]!.rank).toBeGreaterThan(0);
    expect(hits[0]!.rank).toBeLessThanOrEqual(1);
    // The snippet re-parses the content with highlight marks.
    expect(hits[1]!.snippet).toContain("**deploy**");

    const limited = await memoryService.searchMemories(a, "deploying", 1);
    expect(limited).toHaveLength(1);
  });

  it("the ILIKE arm recovers a partial key handle; metacharacters stay literal", async () => {
    const a = await seedAgent("ilike");
    await save(a, "deploy-notes", "ship it");
    const partial = await memoryService.searchMemories(a, "eploy-no");
    expect(partial.map((h) => h.key)).toEqual(["deploy-notes"]);

    // A literal % must not become a wildcard.
    await save(a, "percent", "one hundred % done");
    const literal = await memoryService.searchMemories(a, "%");
    expect(literal.map((h) => h.key)).toEqual([]);
  });
});

describe.skipIf(!PROOF_URL)("cascade + attribution", () => {
  it("deleting the agent deletes its memories and their revisions", async () => {
    const a = await seedAgent("cascade");
    const { memory } = await save(a, "fact", "x");
    await db.agent.delete({ where: { id: a } });
    expect(await db.agentMemory.count({ where: { id: memory.id } })).toBe(0);
    expect(
      await db.agentMemoryRevision.count({ where: { memoryId: memory.id } }),
    ).toBe(0);
  });

  it("deleting the author SetNulls the FK and the denormalized email survives", async () => {
    const scratchUser = await db.user.create({
      data: {
        id: `${P}scratch`,
        email: `${P}scratch@example.com`,
        externalAuthId: `${P}scratch-auth`,
      },
      select: { id: true, email: true },
    });
    const a = await seedAgent("setnull");
    const { memory } = await memoryService.upsertMemoryByKey(
      WORKSPACE,
      a,
      { key: "fact", content: "x" },
      {
        authorKind: "user",
        authorUserId: scratchUser.id,
        authorEmail: scratchUser.email,
        conversationId: null,
        turnId: null,
      },
    );
    await db.user.delete({ where: { id: scratchUser.id } });
    const revision = await db.agentMemoryRevision.findFirstOrThrow({
      where: { memoryId: memory.id, seq: 1 },
    });
    expect(revision.authorUserId).toBeNull();
    expect(revision.authorEmail).toBe(`${P}scratch@example.com`);
  });

  it("a tool save through a real turn audits under the via-user; a userless turn audits nothing but records provenance", async () => {
    const a = await seedAgent("audit");
    await db.sandbox.create({
      data: {
        id: `${P}sb-audit`,
        agentId: a,
        runnerId: RUNNER_A,
        status: "running",
      },
    });
    const conversation = await db.conversation.create({
      data: { agentId: a, source: "web", userId: USER, direct: true },
      select: { id: true },
    });
    const humanTurn = await db.turn.create({
      data: {
        conversationId: conversation.id,
        status: "running",
        source: "web",
        userId: USER,
        message: "remember this",
      },
      select: { id: true },
    });

    const attributed = await platformTools.executePlatformTool(RUNNER_A, {
      sandboxId: `${P}sb-audit`,
      tool: "memory_save",
      args: { key: "from-chat", content: "attributed fact" },
      conversationId: conversation.id,
      turnId: humanTurn.id,
    });
    expect(attributed.ok).toBe(true);
    const chatRevision = await db.agentMemoryRevision.findFirstOrThrow({
      where: { memory: { agentId: a, key: "from-chat" } },
    });
    expect(chatRevision).toMatchObject({
      authorKind: "agent",
      authorUserId: USER,
      authorEmail: `${P}user@example.com`,
    });
    const audits = await db.auditLog.findMany({ where: { userId: USER } });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toMatchObject({
      viaAgent: "true",
      key: "from-chat",
    });

    // The scheduled-run shape: a turn with no user.
    const cronConversation = await db.conversation.create({
      data: { agentId: a, source: "cron", externalRef: `${P}cron-1` },
      select: { id: true },
    });
    const cronTurn = await db.turn.create({
      data: {
        conversationId: cronConversation.id,
        status: "running",
        source: "cron",
        userId: null,
        message: "[Scheduled run]",
      },
      select: { id: true },
    });
    const unattributed = await platformTools.executePlatformTool(RUNNER_A, {
      sandboxId: `${P}sb-audit`,
      tool: "memory_save",
      args: { key: "from-cron", content: "cron finding" },
      conversationId: cronConversation.id,
      turnId: cronTurn.id,
    });
    expect(unattributed.ok).toBe(true);
    expect(await db.auditLog.count({ where: { userId: USER } })).toBe(1);

    // The revision records provenance honestly either way.
    const cronRevision = await db.agentMemoryRevision.findFirstOrThrow({
      where: { memory: { agentId: a, key: "from-cron" } },
    });
    expect(cronRevision).toMatchObject({
      authorKind: "agent",
      authorUserId: null,
      conversationId: cronConversation.id,
      turnId: cronTurn.id,
    });
  });

  it("the dispatch claim carries the turn's agent id for the context builder", async () => {
    const a = await seedAgent("claim");
    await db.sandbox.create({
      data: {
        id: `${P}sb-claim`,
        agentId: a,
        runnerId: RUNNER_A,
        status: "running",
      },
    });
    const conversation = await db.conversation.create({
      data: { agentId: a, source: "web", userId: USER, direct: true },
      select: { id: true },
    });
    await db.turn.create({
      data: {
        conversationId: conversation.id,
        status: "queued",
        source: "web",
        userId: USER,
        message: "hi",
      },
    });
    const claimed = await dueWork.claimDueWork(RUNNER_A, 5);
    const turn = claimed.find((item) => item.kind === "turn");
    expect(turn && turn.kind === "turn" && turn.agentId).toBe(a);
  });
});
