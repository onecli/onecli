import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_SYNC_PART_BYTES,
  MAX_SYNC_PARTS,
  isUnmodifiedProjection,
  runnerWorkItemSchema,
  syncFrameByteLength,
} from "@onecli/agent-protocol";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * The home-sync seam on REAL PostgreSQL (step 9): the sixth due-work
 * arm (claim/budget/fence/pacing), reset-on-start, the lt-guarded ack, the
 * sync-before-turns ordering, the tier bumps (never waking a parked box),
 * and the composer (gateway entry, shadowing, memory projection, byte
 * packing with multi-byte content, containment braces).
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type DueWork = typeof import("./due-work");
type SyncService = typeof import("./home-sync-service");
type SandboxService = typeof import("./sandbox-service");
type SkillService = typeof import("./skill-service");
type MemoryService = typeof import("./agent-memory-service");
type GatewaySkill = typeof import("../lib/skills/gateway-skill");

let db: Db;
let dueWork: DueWork;
let syncService: SyncService;
let sandboxService: SandboxService;
let skillService: SkillService;
let memoryService: MemoryService;
let gatewaySkill: GatewaySkill;

const P = "wss-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const WORKSPACE_B = `${P}ws-b`;
const RUNNER_A = `${P}runner-a`;
const RUNNER_B = `${P}runner-b`;
const USER = `${P}user`;

const CREATOR = { userId: USER, email: `${P}user@example.com` };
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
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";

  ({ db } = await import("@onecli/db"));
  dueWork = await import("./due-work");
  syncService = await import("./home-sync-service");
  sandboxService = await import("./sandbox-service");
  skillService = await import("./skill-service");
  memoryService = await import("./agent-memory-service");
  gatewaySkill = await import("../lib/skills/gateway-skill");

  await resetAll();
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await resetAll();
});

const resetAll = async () => {
  await db.skill.deleteMany({
    where: {
      OR: [
        { workspaceId: { startsWith: P } },
        { organizationId: { startsWith: P } },
        { agent: { identifier: { startsWith: P } } },
      ],
    },
  });
  await db.agentMemory.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.turn.deleteMany({
    where: { conversation: { agent: { identifier: { startsWith: P } } } },
  });
  await db.conversation.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.sandbox.deleteMany({
    where: { OR: [{ id: { startsWith: P } }, { runnerId: { startsWith: P } }] },
  });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
  await db.auditLog.deleteMany({ where: { userId: USER } });
  await db.user.deleteMany({ where: { id: USER } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

beforeEach(async () => {
  if (!PROOF_URL) return;
  await resetAll();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "P", organizationId: ORG },
  });
  await db.workspace.create({
    data: { id: WORKSPACE_B, name: "PB", organizationId: ORG },
  });
  await db.user.create({
    data: {
      id: USER,
      email: `${P}user@example.com`,
      externalAuthId: `${P}auth`,
    },
  });
  await db.runner.createMany({
    data: [
      { id: RUNNER_A, name: "a", token: `rnr_${P}a` },
      { id: RUNNER_B, name: "b", token: `rnr_${P}b` },
    ],
  });
});

const seedAgent = async (suffix: string, workspaceId = WORKSPACE) => {
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `agent ${suffix}`,
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  return agent.id;
};

const seedSandbox = async (
  suffix: string,
  agentId: string,
  status = "running",
  overrides: {
    desired?: number;
    applied?: number;
    claimedAt?: Date | null;
    runnerId?: string;
  } = {},
) => {
  const sandbox = await db.sandbox.create({
    data: {
      id: `${P}sb-${suffix}`,
      agentId,
      runnerId: overrides.runnerId ?? RUNNER_A,
      status,
      homeDesiredGeneration: overrides.desired ?? 1,
      homeAppliedGeneration: overrides.applied ?? 0,
      homeSyncClaimedAt: overrides.claimedAt ?? null,
    },
    select: { id: true },
  });
  return sandbox.id;
};

const sandboxRow = (id: string) =>
  db.sandbox.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      homeDesiredGeneration: true,
      homeAppliedGeneration: true,
      homeSyncClaimedAt: true,
    },
  });

describe.skipIf(!PROOF_URL)("the sync claim arm", () => {
  it("claims a running behind sandbox, stamping ONLY the pacing clock", async () => {
    const agent = await seedAgent("claim");
    const sb = await seedSandbox("claim", agent, "running", {
      desired: 3,
      applied: 1,
    });
    const before = await sandboxRow(sb);

    const claimed = await dueWork.claimDueWork(RUNNER_A, 5);
    const sync = claimed.find((item) => item.kind === "home.sync");
    expect(sync).toMatchObject({
      sandboxId: sb,
      agentId: agent,
      generation: 3,
    });

    const after = await sandboxRow(sb);
    expect(after.homeSyncClaimedAt).not.toBeNull();
    // applied moves on the ACK alone — a claim-time stamp would be the
    // boolean-flag trap in generation clothing.
    expect(after.homeAppliedGeneration).toBe(1);
    expect(after.status).toBe(before.status);
  });

  it("respects its own budget, the runner fence, and the pacing window", async () => {
    for (let i = 0; i < 5; i += 1) {
      const agent = await seedAgent(`budget-${i}`);
      await seedSandbox(`budget-${i}`, agent, "running", { desired: 2 });
    }
    const foreignAgent = await seedAgent("foreign-runner");
    await seedSandbox("foreign-runner", foreignAgent, "running", {
      desired: 2,
      runnerId: RUNNER_B,
    });

    const claimed = await dueWork.claimDueWork(RUNNER_A, 10);
    const syncs = claimed.filter((item) => item.kind === "home.sync");
    // HOME_SYNC_LIMIT = 3 — the CTE-not-subquery mutation dies here.
    expect(syncs).toHaveLength(3);
    expect(
      syncs.every((item) => !item.sandboxId.includes("foreign-runner")),
    ).toBe(true);

    // The just-claimed rows sit out the pacing window…
    const again = await dueWork.claimDueWork(RUNNER_A, 10);
    // (the two unclaimed-from-round-one rows are claimable now)
    expect(again.filter((i) => i.kind === "home.sync")).toHaveLength(2);

    // …and a BACKDATED claim re-arms.
    const stale = new Date(Date.now() - 120_000);
    await db.sandbox.updateMany({
      where: { id: { startsWith: `${P}sb-budget-` } },
      data: { homeSyncClaimedAt: stale },
    });
    const reclaimed = await dueWork.claimDueWork(RUNNER_A, 10);
    expect(reclaimed.filter((i) => i.kind === "home.sync")).toHaveLength(3);
  });

  it("never claims a parked sandbox — and a bump never wakes one", async () => {
    const agent = await seedAgent("parked");
    const sb = await seedSandbox("parked", agent, "stopped", { desired: 1 });

    await syncService.bumpHomeForAgent(agent);
    const row = await sandboxRow(sb);
    expect(row.homeDesiredGeneration).toBe(2);
    expect(row.status).toBe("stopped");

    const claimed = await dueWork.claimDueWork(RUNNER_A, 10);
    expect(claimed.filter((i) => i.kind === "home.sync")).toHaveLength(0);
    // No queued turn either → the start arm leaves it parked too.
    expect(claimed.filter((i) => i.kind === "start")).toHaveLength(0);
  });

  it("orders syncs BEFORE turns in one claim batch", async () => {
    const agent = await seedAgent("order");
    const sb = await seedSandbox("order", agent, "running", {
      desired: 2,
      applied: 1,
    });
    const conversation = await db.conversation.create({
      data: { agentId: agent, source: "web", userId: USER, direct: true },
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

    const claimed = await dueWork.claimDueWork(RUNNER_A, 10);
    const syncIndex = claimed.findIndex((i) => i.kind === "home.sync");
    const turnIndex = claimed.findIndex((i) => i.kind === "turn");
    expect(syncIndex).toBeGreaterThanOrEqual(0);
    expect(turnIndex).toBeGreaterThan(syncIndex);
    expect(claimed[turnIndex]).toMatchObject({ sandboxId: sb });
  });

  it("reset-on-start: every start claim zeroes applied and clears the lease", async () => {
    const agent = await seedAgent("reset");
    const sb = await seedSandbox("reset", agent, "unprovisioned", {
      desired: 4,
      applied: 4,
      claimedAt: new Date(),
    });
    const claimed = await dueWork.claimDueWork(RUNNER_A, 5);
    expect(claimed.find((i) => i.kind === "start")).toMatchObject({
      sandboxId: sb,
    });
    const row = await sandboxRow(sb);
    expect(row.status).toBe("starting");
    expect(row.homeAppliedGeneration).toBe(0);
    expect(row.homeSyncClaimedAt).toBeNull();
  });
});

describe.skipIf(!PROOF_URL)("the ack", () => {
  it("is lt-guarded max(), fenced by runner, clears the lease, wakes nothing", async () => {
    const agent = await seedAgent("ack");
    const sb = await seedSandbox("ack", agent, "running", {
      desired: 5,
      applied: 2,
      claimedAt: new Date(),
    });

    const waiters = dueWork.pendingWaiterCount();
    await sandboxService.applyRunnerEvent(RUNNER_A, {
      kind: "home.synced",
      sandboxId: sb,
      generation: 5,
    });
    let row = await sandboxRow(sb);
    expect(row.homeAppliedGeneration).toBe(5);
    expect(row.homeSyncClaimedAt).toBeNull();
    expect(dueWork.pendingWaiterCount()).toBe(waiters);

    // A STALE ack is inert.
    await sandboxService.applyRunnerEvent(RUNNER_A, {
      kind: "home.synced",
      sandboxId: sb,
      generation: 3,
    });
    row = await sandboxRow(sb);
    expect(row.homeAppliedGeneration).toBe(5);

    // A cross-runner forgery is inert. (The lease is restored so this step
    // isolates the RUNNER fence — the ack's other two fences stay satisfied.)
    await db.sandbox.update({
      where: { id: sb },
      data: {
        homeAppliedGeneration: 1,
        homeSyncClaimedAt: new Date(),
      },
    });
    await sandboxService.applyRunnerEvent(RUNNER_B, {
      kind: "home.synced",
      sandboxId: sb,
      generation: 9,
    });
    row = await sandboxRow(sb);
    expect(row.homeAppliedGeneration).toBe(1);
  });

  it("an ack from a container that has since RESTARTED is inert (the lease fence)", async () => {
    // The race: the old container acked generation 4, its ack sat in the
    // runner's report batch, the sandbox restarted (start claim → applied 0,
    // lease NULL), and only then did the ack land. Counting it would mark a
    // FRESH container synced without a single file written.
    const agent = await seedAgent("ack-restart");
    const sb = await seedSandbox("ack-restart", agent, "unprovisioned", {
      desired: 4,
      applied: 4,
      claimedAt: new Date(),
    });

    // The restart: the start claim is the reset.
    await dueWork.claimDueWork(RUNNER_A, 5);
    expect((await sandboxRow(sb)).homeAppliedGeneration).toBe(0);

    await sandboxService.applyRunnerEvent(RUNNER_A, {
      kind: "home.synced",
      sandboxId: sb,
      generation: 4,
    });

    const row = await sandboxRow(sb);
    expect(row.homeAppliedGeneration).toBe(0);
    expect(row.homeSyncClaimedAt).toBeNull();
  });
});

describe.skipIf(!PROOF_URL)("the bumps", () => {
  it("fence per tier: agent, workspace, organization — foreign rows untouched", async () => {
    const a1 = await seedAgent("bump-a1");
    const a2 = await seedAgent("bump-a2");
    const b1 = await seedAgent("bump-b1", WORKSPACE_B);
    const sbA1 = await seedSandbox("bump-a1", a1);
    const sbA2 = await seedSandbox("bump-a2", a2);
    const sbB1 = await seedSandbox("bump-b1", b1);

    await syncService.bumpHomeForAgent(a1);
    expect((await sandboxRow(sbA1)).homeDesiredGeneration).toBe(2);
    expect((await sandboxRow(sbA2)).homeDesiredGeneration).toBe(1);

    await syncService.bumpHomeForWorkspace(WORKSPACE);
    expect((await sandboxRow(sbA1)).homeDesiredGeneration).toBe(3);
    expect((await sandboxRow(sbA2)).homeDesiredGeneration).toBe(2);
    expect((await sandboxRow(sbB1)).homeDesiredGeneration).toBe(1);

    await syncService.bumpHomeForOrganization(ORG);
    expect((await sandboxRow(sbA1)).homeDesiredGeneration).toBe(4);
    expect((await sandboxRow(sbB1)).homeDesiredGeneration).toBe(2);
  });

  it("skill and memory writes bump through the services; no-ops and redact do not", async () => {
    const agent = await seedAgent("bump-writes");
    const sb = await seedSandbox("bump-writes", agent);
    const desired = async () => (await sandboxRow(sb)).homeDesiredGeneration;

    await skillService.createSkill(
      WORKSPACE,
      { name: "bumps", description: "d", content: "c" },
      CREATOR,
    );
    expect(await desired()).toBe(2);

    const { memory } = await memoryService.upsertMemoryByKey(
      WORKSPACE,
      agent,
      { key: "fact", content: "v1" },
      AUTHOR,
    );
    expect(await desired()).toBe(3);

    // No-op memory save: no bump.
    await memoryService.upsertMemoryByKey(
      WORKSPACE,
      agent,
      { key: "fact", content: "v1" },
      AUTHOR,
    );
    expect(await desired()).toBe(3);

    // Redact an OLD revision: head untouched → no bump.
    await memoryService.updateMemory(
      WORKSPACE,
      agent,
      memory.id,
      { content: "v2" },
      AUTHOR,
    );
    expect(await desired()).toBe(4);
    const revisions = await memoryService.listRevisions(
      WORKSPACE,
      agent,
      memory.id,
    );
    const oldRev = revisions.find((r) => r.seq === 1);
    await memoryService.redactRevision(
      WORKSPACE,
      agent,
      memory.id,
      oldRev!.id,
      USER,
    );
    expect(await desired()).toBe(4);
  });
});

describe.skipIf(!PROOF_URL)("the composer", () => {
  it("always carries the gateway skill, byte-identical to the route's answer", async () => {
    const agent = await seedAgent("composer-gw");
    const files = await syncService.buildHomeFileSet(agent);
    const gw = files.find(
      (f) => f.path === ".agents/skills/onecli-gateway/SKILL.md",
    );
    expect(gw?.content).toBe(gatewaySkill.getGatewaySkill("fake"));
  });

  it("shadows by specificity (agent > workspace > organization); disabled filtered BEFORE the merge", async () => {
    const agent = await seedAgent("composer-shadow");
    await db.skill.createMany({
      data: [
        {
          scope: "organization",
          organizationId: ORG,
          name: "deploy",
          description: "org tier",
          content: "ORG BODY",
        },
        {
          scope: "workspace",
          workspaceId: WORKSPACE,
          name: "deploy",
          description: "workspace tier",
          content: "WORKSPACE BODY",
        },
        {
          scope: "agent",
          agentId: agent,
          name: "deploy",
          description: "agent tier",
          content: "AGENT BODY",
          enabled: false,
        },
      ],
    });
    const files = await syncService.buildHomeFileSet(agent);
    const skillMd = files.find(
      (f) => f.path === ".agents/skills/deploy/SKILL.md",
    );
    // The DISABLED agent row leaves the projection — it never tombstones the
    // broader tier: the workspace tier wins.
    expect(skillMd?.content).toContain("WORKSPACE BODY");
    expect(skillMd?.content).not.toContain("AGENT BODY");
  });

  it("workspaces memories as files with the index derivation the turn context uses", async () => {
    const agent = await seedAgent("composer-mem");
    await memoryService.upsertMemoryByKey(
      WORKSPACE,
      agent,
      {
        key: "staging-url",
        content: "https://staging.acme.dev",
        description: "Where staging lives: the URL",
      },
      AUTHOR,
    );
    const files = await syncService.buildHomeFileSet(agent);
    const memoryMd = files.find((f) => f.path === "memory/staging-url.md");
    expect(memoryMd?.content).toContain("https://staging.acme.dev");
    // The write-back format: the sync banner plus a VERIFYING checksum —
    // the self-authenticating line the whole harvest design leans on. A DB
    // round-trip that broke render-stability (title/description
    // normalization) would fail the verification here.
    expect(memoryMd?.content).toContain("Synced with OneCLI");
    expect(isUnmodifiedProjection(memoryMd?.content ?? "")).toBe(true);
    const index = files.find((f) => f.path === "memory/index.md");
    expect(index?.content).toContain(
      "- [staging-url](./staging-url.md): Where staging lives: the URL",
    );
  });

  it("frontmatter folding keeps a hostile description one safe scalar", async () => {
    const agent = await seedAgent("composer-yaml");
    await skillService.createSkill(
      WORKSPACE,
      {
        name: "tricky",
        description: 'colon: and "quotes" and more: colons',
        content: "body",
      },
      CREATOR,
    );
    const files = await syncService.buildHomeFileSet(agent);
    const md = files.find((f) => f.path === ".agents/skills/tricky/SKILL.md");
    expect(md?.content).toContain(
      'description: >-\n  colon: and "quotes" and more: colons',
    );
  });

  it("containment braces: a DB-planted traversal file skips its whole skill, the set survives", async () => {
    const agent = await seedAgent("composer-poison");
    const poisoned = await db.skill.create({
      data: {
        scope: "workspace",
        workspaceId: WORKSPACE,
        name: "poisoned",
        description: "d",
        content: "c",
      },
      select: { id: true },
    });
    // Bypass the belt (raw insert): a path the wire could never carry.
    await db.$executeRaw`INSERT INTO "skill_files" ("id", "skill_id", "path", "content", "created_at", "updated_at") VALUES (${"wss-poison-file"}, ${poisoned.id}, ${"../../evil"}, ${"x"}, now(), now())`;
    await skillService.createSkill(
      WORKSPACE,
      {
        name: "healthy",
        description: "d",
        content: "c",
      },
      CREATOR,
    );

    const files = await syncService.buildHomeFileSet(agent);
    const paths = files.map((f) => f.path);
    expect(paths.some((p) => p.includes("poisoned"))).toBe(false);
    expect(paths).toContain(".agents/skills/healthy/SKILL.md");
  });

  it("a legal two-segment skill file composes (the 5-segment containment case)", async () => {
    // references/api.md — the validation's own example. Root (2) + name +
    // two file segments = 5; a tighter brace silently dropped the WHOLE
    // skill from the projection.
    const agent = await seedAgent("composer-twoseg");
    await skillService.createSkill(
      WORKSPACE,
      {
        name: "with-refs",
        description: "d",
        content: "c",
        files: [{ path: "references/api.md", content: "ref body" }],
      },
      CREATOR,
    );
    const paths = (await syncService.buildHomeFileSet(agent)).map(
      (f) => f.path,
    );
    expect(paths).toContain(".agents/skills/with-refs/SKILL.md");
    expect(paths).toContain(".agents/skills/with-refs/references/api.md");
  });

  it("a DB-planted user skill named onecli-gateway never displaces the builtin", async () => {
    const agent = await seedAgent("composer-reserved");
    await db.skill.create({
      data: {
        scope: "workspace",
        workspaceId: WORKSPACE,
        name: "onecli-gateway",
        description: "squatter",
        content: "FAKE GATEWAY",
      },
    });
    const files = await syncService.buildHomeFileSet(agent);
    const gw = files.find(
      (f) => f.path === ".agents/skills/onecli-gateway/SKILL.md",
    );
    expect(gw?.content).not.toContain("FAKE GATEWAY");
    expect(gw?.content).toBe(gatewaySkill.getGatewaySkill("fake"));
  });

  it("packs by BYTES: multi-byte memories split into parts under the cap", async () => {
    const agent = await seedAgent("composer-pack");
    const sb = await seedSandbox("composer-pack", agent);
    // Six memories of 11k CJK chars each ≈ 33KB serialized apiece — a chars
    // budget would cram them all into one part and blow the WS cap.
    for (let i = 0; i < 6; i += 1) {
      await memoryService.upsertMemoryByKey(
        WORKSPACE,
        agent,
        { key: `cjk-${i}`, content: "世".repeat(11_000) },
        AUTHOR,
      );
    }
    const item = await syncService.buildHomeSyncItem(agent, sb, 7);
    if (!item || item.kind !== "skills.changed") throw new Error("no item");
    expect(item.parts.length).toBeGreaterThan(1);
    // The wire's own refine re-measures every part with the REAL stamps — a
    // composed item must always survive it (the packer measures worst-case
    // part/of widths so a stamped frame can never outgrow its measurement).
    expect(() => runnerWorkItemSchema.parse(item)).not.toThrow();
    for (const [index, part] of item.parts.entries()) {
      const frame = {
        kind: "skills.changed",
        generation: 7,
        part: index + 1,
        of: item.parts.length,
        ...part,
      };
      expect(syncFrameByteLength(frame)).toBeLessThanOrEqual(
        MAX_SYNC_PART_BYTES,
      );
    }
    // The final part carries the manifest + render inputs; earlier parts none.
    expect(item.parts.at(-1)?.prune?.length).toBeGreaterThan(0);
    expect(item.parts.at(-1)?.agentName).toBe("agent composer-pack");
    expect(item.parts.slice(0, -1).every((p) => p.prune === undefined)).toBe(
      true,
    );
    // MUTATION-PROOF (lens-5 catch): the extras ride a DEDICATED final part
    // (files: []), not merged onto the last FILE part. Merge them onto the
    // last file part and this fails — and `memoryFileFitsFrame`'s bare-frame
    // premise breaks (a near-boundary file + a large brief would exceed the
    // budget and wedge the sync forever), the exact state the design rejects.
    expect(item.parts.at(-1)?.files).toEqual([]);
  });

  it("the AUTHORING caps fit inside MAX_SYNC_PARTS at 3-byte encoding", async () => {
    // The caps count UTF-16 chars; the frame budget counts UTF-8 bytes. A
    // CJK agent that fills its caps is 3× the ASCII size, which is what
    // silently truncated every non-Latin agent at the old cap of 64. This
    // pins the sizing rule, not the current number.
    const agent = await seedAgent("composer-cjk");
    const sb = await seedSandbox("composer-cjk", agent);
    // The workspace tier at its cap, each skill at MAX_SKILL_TOTAL_CHARS.
    await db.$executeRaw`
      INSERT INTO "skills" ("id", "scope", "workspace_id", "name", "description", "content", "created_at", "updated_at")
      SELECT ${P} || 'cjk-' || i, 'workspace', ${WORKSPACE}, 'cjk-' || i, 'd', repeat('世', 32000), now(), now()
      FROM generate_series(1, 20) AS i
    `;
    // The memory tier at its cap, each at MEMORY_CONTENT_MAX_LENGTH.
    await db.$executeRaw`
      INSERT INTO "agent_memories" ("id", "agent_id", "key", "content", "last_revision_seq", "created_at", "updated_at")
      SELECT ${P} || 'cjkmem-' || i, ${agent}, 'cjk-mem-' || i, repeat('世', 12000), 1, now(), now()
      FROM generate_series(1, 100) AS i
    `;

    const item = await syncService.buildHomeSyncItem(agent, sb, 11);
    if (!item || item.kind !== "skills.changed") throw new Error("refused");
    // Nothing dropped: every authored file made it into the manifest.
    expect(item.parts.at(-1)?.prune?.length).toBe(
      // 20 skills + 100 memory files + memory/index.md + the gateway skill
      20 + 100 + 1 + 1,
    );
    expect(() => runnerWorkItemSchema.parse(item)).not.toThrow();
  });

  it("past the part cap it TRUNCATES — never refuses — and prunes only to what shipped", async () => {
    // Pathological authored content: bodies of control characters, which
    // JSON escapes to six bytes apiece, so each skill nearly fills a whole
    // 200KB frame. Refusing here would fail identically every 60s forever and
    // leave the agent with NO projection at all; truncating converges.
    const agent = await seedAgent("composer-cap");
    const sb = await seedSandbox("composer-cap", agent);
    // Raw inserts: the service caps (20 per tier) make this unreachable
    // through any door — which is exactly why the branch is defensive.
    await db.$executeRaw`
      INSERT INTO "skills" ("id", "scope", "workspace_id", "name", "description", "content", "created_at", "updated_at")
      SELECT ${P} || 'cap-' || i, 'workspace', ${WORKSPACE}, 'cap-' || i, 'd', repeat(E'\\x01', 30000), now(), now()
      FROM generate_series(1, ${MAX_SYNC_PARTS + 6}) AS i
    `;

    const item = await syncService.buildHomeSyncItem(agent, sb, 3);
    if (!item || item.kind !== "skills.changed") throw new Error("refused");
    expect(item.parts.length).toBe(MAX_SYNC_PARTS);

    // Every part still fits the wire, and the manifest names exactly the
    // files that shipped — a wider manifest would prune nothing, a narrower
    // one would delete files we just wrote.
    expect(() => runnerWorkItemSchema.parse(item)).not.toThrow();
    const shipped = item.parts.flatMap((part) =>
      part.files.map((file) => file.path),
    );
    expect(item.parts.at(-1)?.prune).toEqual(shipped.filter(Boolean).sort());
  });

  it("is deterministic: two builds produce identical path-sorted sets", async () => {
    const agent = await seedAgent("composer-det");
    await skillService.createSkill(
      WORKSPACE,
      { name: "one", description: "d", content: "c" },
      CREATOR,
    );
    const a = await syncService.buildHomeFileSet(agent);
    const b = await syncService.buildHomeFileSet(agent);
    expect(a).toEqual(b);
    const paths = a.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
  });
});
