import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * The platform-job run rules on REAL PostgreSQL, for a job that is NOT
 * memory review: what the registry promises any registered job
 * (platform-jobs, rules 1 to 4) has to hold through the real claim, the
 * real turn doors and the real context builder, or the mechanism is only
 * memory review under a new name. The memory-review suite pins the same
 * rules for the first job, and this one pins that they follow the
 * registration, not a source string.
 *
 * The second job's run source is borrowed: `webhook` is a real automation
 * source that is no platform job in production, so registering a job on it
 * here (this file's own module graph only) is the cleanest way to give a
 * second job a source the turn doors already accept, with no cast. None of
 * the four doors below branches on `webhook` itself (only settle does, and
 * nothing here settles), so every assertion fails when the registration is
 * dropped.
 *
 * Env-gated like the other proof suites (see pg-proof.ts).
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type DueWork = typeof import("./due-work");
type TurnService = typeof import("./turn-service");
type TurnContext = typeof import("./turn-context-service");
type Conversations = typeof import("./conversation-service");

let db: Db;
let dueWork: DueWork;
let turnService: TurnService;
let turnContext: TurnContext;
let conversations: Conversations;

const P = "pjob-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const RUNNER = `${P}runner`;
const USER = `${P}user`;
/** The second job's run source (see the header). */
const JOB_SOURCE = "webhook";
/** The second job's own dispatch-context block. */
const JOB_BLOCK = "[pjob block: platform-only context for this run]";

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

const clearFixtures = async () => {
  const mine = { conversation: { agent: { identifier: { startsWith: P } } } };
  await db.turnEvent.deleteMany({ where: mine });
  await db.turn.deleteMany({ where: mine });
  await db.conversation.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.agentMemory.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.policyRuleV2.deleteMany({ where: { name: { startsWith: P } } });
  await db.secret.deleteMany({ where: { name: { startsWith: P } } });
  await db.sandbox.deleteMany({ where: { runnerId: RUNNER } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";

  ({ db } = await import("@onecli/db"));
  dueWork = await import("./due-work");
  turnService = await import("./turn-service");
  turnContext = await import("./turn-context-service");
  conversations = await import("./conversation-service");
  const { registerPlatformJob } = await import("./platform-jobs");
  registerPlatformJob({
    name: "pjob proof",
    passIntervalMs: 60_000,
    pass: async () => undefined,
    runs: {
      source: JOB_SOURCE,
      context: async () => JOB_BLOCK,
    },
  });

  await clearFixtures();
  await db.runner.deleteMany({ where: { id: RUNNER } });
  await db.user.deleteMany({ where: { id: USER } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Platform jobs", organizationId: ORG },
  });
  await db.user.create({
    data: {
      id: USER,
      email: `${P}user@example.com`,
      name: "Job User",
      externalAuthId: `${P}auth`,
    },
  });
  await db.runner.create({
    data: { id: RUNNER, name: "runner", token: `rnr_${P}r` },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await clearFixtures();
  await db.runner.deleteMany({ where: { id: RUNNER } });
  await db.user.deleteMany({ where: { id: USER } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await clearFixtures();
});

/** A hosted agent on a running sandbox, its clocks quiet since `quietAt`,
 * with an injectable LLM key (door 1). */
const seedAgent = async (suffix: string, quietAt: Date) => {
  const agent = await db.agent.create({
    data: {
      workspaceId: WORKSPACE,
      name: `agent ${suffix}`,
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  const sandboxId = `${P}sb-${suffix}`;
  await db.sandbox.create({
    data: {
      id: sandboxId,
      agentId: agent.id,
      runnerId: RUNNER,
      status: "running",
      lastActiveAt: quietAt,
      lastEngagedAt: quietAt,
    },
  });
  const secret = await db.secret.create({
    data: {
      scope: "workspace",
      workspaceId: WORKSPACE,
      name: `${P}${suffix}`,
      type: "anthropic",
      encryptedValue: "enc",
      hostPattern: "api.anthropic.com",
      metadata: { authMode: "api-key" },
    },
    select: { id: true },
  });
  await db.policyRuleV2.create({
    data: {
      scope: "workspace",
      workspaceId: WORKSPACE,
      status: "published",
      generation: 1,
      priority: 10,
      isDefault: false,
      enabled: true,
      source: "equipment",
      logicalId: `${P}${suffix}`,
      name: `${P}${suffix}`,
      action: "allow",
      requireApproval: false,
      identities: { create: [{ agentId: agent.id }] },
      targets: { create: [{ kind: "secret", secretId: secret.id }] },
    },
  });
  return { agentId: agent.id, sandboxId };
};

/** The job's own conversation, the way a job's pass opens one. */
const seedJobConversation = (agentId: string, sessionRef?: string) =>
  db.conversation.create({
    data: {
      agentId,
      source: JOB_SOURCE,
      externalRef: `${P}ref`,
      harnessSessionRef: sessionRef ?? null,
    },
    select: { id: true },
  });

/** Fire one run the way a job's pass does: the platform door, no user. */
const fireRun = (conversationId: string, message = "do the job") =>
  turnService.createTurn(WORKSPACE, conversationId, message, {
    source: JOB_SOURCE,
    userId: null,
  });

describe.skipIf(!PROOF_URL)("a second platform job gets every run rule", () => {
  it("rule 1: its run is claimed on a fresh session that ends with it", async () => {
    const { agentId, sandboxId } = await seedAgent("fresh", minutesAgo(25));
    const conv = await seedJobConversation(agentId, "previous-run-session");
    await fireRun(conv.id);

    const claimed = await dueWork.claimDueWork(RUNNER, 5);
    expect(
      claimed.find(
        (item) => item.kind === "turn" && item.sandboxId === sandboxId,
      ),
    ).toMatchObject({
      kind: "turn",
      conversationId: conv.id,
      resumeSessionRef: null,
      ephemeralSession: true,
    });
  });

  it("rule 2: its run never restarts the sandbox's clocks, from create to progress", async () => {
    const quietSince = minutesAgo(25);
    const { agentId, sandboxId } = await seedAgent("quiet", quietSince);
    const conv = await seedJobConversation(agentId);
    const run = await fireRun(conv.id);
    await db.turn.update({
      where: { id: run.id },
      data: { status: "running" },
    });
    const reporter = { sandboxId, runnerId: RUNNER };
    await turnService.applyTurnEvents(reporter, conv.id, run.id, [
      { type: "text", text: "done" },
    ]);
    await turnService.applyTurnProgress(reporter, conv.id, run.id);

    const box = await db.sandbox.findUniqueOrThrow({
      where: { id: sandboxId },
      select: { lastActiveAt: true, lastEngagedAt: true },
    });
    expect(box.lastActiveAt?.getTime()).toBe(quietSince.getTime());
    expect(box.lastEngagedAt?.getTime()).toBe(quietSince.getTime());
  });

  it("rule 3: its conversation takes its runs only, and its source writes nowhere else", async () => {
    const { agentId } = await seedAgent("sealed", minutesAgo(25));
    const conv = await seedJobConversation(agentId);
    const other = await db.conversation.create({
      data: { agentId, source: "web" },
      select: { id: true },
    });

    // No client mints a conversation on its source.
    await expect(
      conversations.createConversation(WORKSPACE, {
        agentId,
        source: JOB_SOURCE,
        externalRef: other.id,
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    // A member speaking in it, and memory review's platform door, both refused.
    await expect(
      turnService.createTurn(WORKSPACE, conv.id, "hi", {
        source: "web",
        userId: USER,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      turnService.createTurn(WORKSPACE, conv.id, "hi", {
        source: "memory_review",
        userId: null,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Its own source refused in an ordinary conversation.
    await expect(fireRun(other.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // Its own run lands.
    await expect(fireRun(conv.id)).resolves.toMatchObject({
      status: "queued",
    });
    expect(await db.turn.count({ where: { conversationId: conv.id } })).toBe(1);
  });

  it("rule 4: its dispatch context is the memory index plus its own block, never stored", async () => {
    const { agentId } = await seedAgent("context", minutesAgo(25));
    await db.agentMemory.create({
      data: {
        agentId,
        key: "fiscal-year",
        description: "Fiscal year starts in February",
        content: "Fiscal year starts in February.",
      },
    });
    const conv = await seedJobConversation(agentId);
    const run = await fireRun(conv.id, "do the job");

    const context = await turnContext.buildTurnContext(
      agentId,
      conv.id,
      run.id,
      "do the job",
    );
    expect(context).toContain("fiscal-year: Fiscal year starts in February");
    expect(context).toContain(JOB_BLOCK);
    // The block came from the job at dispatch: the stored message is only
    // the run's instruction.
    const stored = await db.turn.findUniqueOrThrow({
      where: { id: run.id },
      select: { message: true },
    });
    expect(stored.message).toBe("do the job");
  });
});
