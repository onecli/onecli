import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * Context fit on REAL PostgreSQL. What only pg can prove: the candidate
 * query's cooldown/evidence-boundary/source arithmetic over real rows, the
 * conditional write that lets two racing passes change a size exactly once,
 * the audit row landing in the same transaction, the claim carrying the size
 * onto the next turn, and the trial-credit clamp at dispatch.
 *
 * Env-gated like the other proof suites; see pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type ContextFit = typeof import("./context-fit-service");
type DueWork = typeof import("./due-work");
type LlmCredential = typeof import("./llm-credential-service");
type PlatformLlm = typeof import("../providers/platform-llm");

let db: Db;
let contextFit: ContextFit;
let dueWork: DueWork;
let llmCredential: LlmCredential;
let platformLlm: PlatformLlm;

const P = "ctxfit-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OTHER_ORG = `${P}org-b`;
const OTHER_WORKSPACE = `${P}ws-b`;
const RUNNER = `${P}runner`;
const OWNER = `${P}owner`;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

const clearFixtures = async () => {
  const mine = { conversation: { agent: { identifier: { startsWith: P } } } };
  await db.turnEvent.deleteMany({ where: mine });
  await db.turn.deleteMany({ where: mine });
  await db.conversation.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.auditLog.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
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
  contextFit = await import("./context-fit-service");
  dueWork = await import("./due-work");
  llmCredential = await import("./llm-credential-service");
  platformLlm = await import("../providers/platform-llm");

  await clearFixtures();
  await db.organizationMember.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
  await db.runner.deleteMany({ where: { id: RUNNER } });
  await db.user.deleteMany({ where: { id: OWNER } });
  await db.workspace.deleteMany({
    where: { id: { in: [WORKSPACE, OTHER_WORKSPACE] } },
  });
  await db.organization.deleteMany({
    where: { id: { in: [ORG, OTHER_ORG] } },
  });
  for (const [org, ws] of [
    [ORG, WORKSPACE],
    [OTHER_ORG, OTHER_WORKSPACE],
  ] as const) {
    await db.organization.create({ data: { id: org, name: org, slug: org } });
    await db.workspace.create({
      data: { id: ws, name: ws, organizationId: org },
    });
  }
  await db.user.create({
    data: {
      id: OWNER,
      email: `${P}owner@example.com`,
      name: "Owner",
      externalAuthId: `${P}auth`,
      signInProvider: "Google",
    },
  });
  // The service-audit row is anchored on the org owner (no owner, no row).
  await db.organizationMember.create({
    data: {
      organizationId: ORG,
      userId: OWNER,
      userEmail: `${P}owner@example.com`,
      role: "owner",
    },
  });
  await db.runner.create({
    data: { id: RUNNER, name: "runner", token: `rnr_${P}r` },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  platformLlm?.initPlatformLlm(null);
  await clearFixtures();
  await db.organizationMember.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
  await db.runner.deleteMany({ where: { id: RUNNER } });
  await db.user.deleteMany({ where: { id: OWNER } });
  await db.workspace.deleteMany({
    where: { id: { in: [WORKSPACE, OTHER_WORKSPACE] } },
  });
  await db.organization.deleteMany({
    where: { id: { in: [ORG, OTHER_ORG] } },
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  platformLlm.initPlatformLlm(null);
  await clearFixtures();
});

const seedAgent = async (
  suffix: string,
  workspaceId = WORKSPACE,
  { withKey = true }: { withKey?: boolean } = {},
) => {
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
  await db.sandbox.create({
    data: {
      id: `${P}sb-${suffix}`,
      agentId: agent.id,
      runnerId: RUNNER,
      status: "running",
    },
  });
  if (withKey) {
    const secret = await db.secret.create({
      data: {
        scope: "workspace",
        workspaceId,
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
        workspaceId,
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
  }
  return agent.id;
};

const seedConversation = (
  agentId: string,
  overrides: {
    source?: string;
    contextTokens?: number;
    changedAt?: Date;
  } = {},
) =>
  db.conversation.create({
    data: {
      agentId,
      source: overrides.source ?? "web",
      ...(overrides.contextTokens !== undefined && {
        contextTokens: overrides.contextTokens,
        contextTokensChangedAt: overrides.changedAt ?? minutesAgo(120),
      }),
    },
    select: { id: true },
  });

/** `fills` finished turns, oldest first, each `fill` tokens of context
 * (split across the three input fields like a cached Anthropic call, with
 * the harness's normalized `promptTokens`). */
const seedTurns = async (
  conversationId: string,
  fills: readonly number[],
  { endingMinutesAgo = 1 }: { endingMinutesAgo?: number } = {},
) => {
  for (const [i, fill] of fills.entries()) {
    const at = minutesAgo(endingMinutesAgo + (fills.length - 1 - i));
    await db.turn.create({
      data: {
        conversationId,
        message: `m${i}`,
        source: "web",
        status: "done",
        createdAt: at,
        updatedAt: at,
        finishedAt: at,
        usage: {
          inputTokens: 10,
          outputTokens: 200,
          cacheReadInputTokens: Math.floor(fill * 0.9),
          cacheCreationInputTokens: fill - 10 - Math.floor(fill * 0.9),
          promptTokens: fill,
        },
      },
    });
  }
};

const sizeOf = async (conversationId: string) =>
  db.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { contextTokens: true, contextTokensChangedAt: true },
  });

const repeat = (fill: number, times: number) =>
  Array.from({ length: times }, () => fill);

describe.skipIf(!PROOF_URL)("context fit (pg)", () => {
  it("grows a conversation that keeps filling 200k, and audits the change as the platform", async () => {
    const agentId = await seedAgent("grow");
    const { id } = await seedConversation(agentId);
    await seedTurns(id, [170_000, 20_000, 175_000, 30_000, 180_000]);

    expect(await contextFit.fitContextSizes()).toBe(1);

    const after = await sizeOf(id);
    expect(after.contextTokens).toBe(1_000_000);
    expect(after.contextTokensChangedAt).not.toBeNull();
    const audit = await db.auditLog.findMany({
      where: { organizationId: ORG, serviceActor: "context-fit" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "update",
      service: "conversation",
      actorKind: "service",
      workspaceId: WORKSPACE,
      metadata: {
        conversationId: id,
        contextTokens: 1_000_000,
        previousContextTokens: null,
      },
    });
  });

  it("shrinks a small conversation, and leaves an in-between one alone", async () => {
    const agentId = await seedAgent("shrink");
    const small = await seedConversation(agentId);
    await seedTurns(small.id, repeat(30_000, 10));
    const middle = await seedConversation(agentId);
    await seedTurns(middle.id, repeat(90_000, 10));

    expect(await contextFit.fitContextSizes()).toBe(1);
    expect((await sizeOf(small.id)).contextTokens).toBe(100_000);
    expect((await sizeOf(middle.id)).contextTokens).toBeNull();
  });

  it("reads the harness's measured prompt, never a sum of the raw counters", async () => {
    // An OpenAI call counts its cache reads INSIDE the input: 120k of
    // prompt, 110k of it cached, reports input 120k + cacheRead 110k.
    // Summing them reads 230k (past the 140k bar on every turn) and would
    // grow a conversation that is only 60% full.
    const agentId = await seedAgent("inclusive");
    const { id } = await seedConversation(agentId);
    for (let i = 0; i < 5; i += 1) {
      const at = minutesAgo(5 - i);
      await db.turn.create({
        data: {
          conversationId: id,
          message: `m${i}`,
          source: "web",
          status: "done",
          createdAt: at,
          updatedAt: at,
          finishedAt: at,
          usage: {
            inputTokens: 120_000,
            outputTokens: 200,
            cacheReadInputTokens: 110_000,
            promptTokens: 120_000,
          },
        },
      });
    }
    expect(await contextFit.fitContextSizes()).toBe(0);
    expect((await sizeOf(id)).contextTokens).toBeNull();
  });

  it("a turn its harness did not measure is no evidence, however full its counters look", async () => {
    // Five turns with no promptTokens (another harness, an unknown
    // provider, a turn from before the field): never a reason to move.
    const agentId = await seedAgent("unmeasured");
    const { id } = await seedConversation(agentId);
    for (let i = 0; i < 5; i += 1) {
      const at = minutesAgo(5 - i);
      await db.turn.create({
        data: {
          conversationId: id,
          message: `m${i}`,
          source: "web",
          status: "done",
          createdAt: at,
          updatedAt: at,
          finishedAt: at,
          usage: {
            inputTokens: 10,
            outputTokens: 200,
            cacheReadInputTokens: 180_000,
            cacheCreationInputTokens: 10_000,
          },
        },
      });
    }
    expect(await contextFit.fitContextSizes()).toBe(0);
    expect((await sizeOf(id)).contextTokens).toBeNull();
  });

  it("an unmeasured turn never crowds a measured one out of the window", async () => {
    // Ten small measured turns, then the newest turn unmeasured: the
    // window is the ten MEASURED turns, so the conversation still shrinks.
    const agentId = await seedAgent("crowded");
    const { id } = await seedConversation(agentId);
    await seedTurns(id, repeat(30_000, 10), { endingMinutesAgo: 2 });
    const at = minutesAgo(1);
    await db.turn.create({
      data: {
        conversationId: id,
        message: "unmeasured",
        source: "web",
        status: "done",
        createdAt: at,
        updatedAt: at,
        finishedAt: at,
        usage: { inputTokens: 30_000, outputTokens: 10 },
      },
    });
    expect(await contextFit.fitContextSizes()).toBe(1);
    expect((await sizeOf(id)).contextTokens).toBe(100_000);
  });

  it("respects the cooldown and only counts turns after the last change", async () => {
    const agentId = await seedAgent("cool");
    // Changed 10 minutes ago: inside the 30-minute cooldown.
    const recent = await seedConversation(agentId, {
      contextTokens: 1_000_000,
      changedAt: minutesAgo(10),
    });
    await seedTurns(recent.id, repeat(1_000, 10), { endingMinutesAgo: 1 });

    // Changed 2 hours ago, but its small turns all PREDATE the change: no
    // evidence at the new size yet.
    const stale = await seedConversation(agentId, {
      contextTokens: 1_000_000,
      changedAt: minutesAgo(120),
    });
    await seedTurns(stale.id, repeat(1_000, 10), { endingMinutesAgo: 130 });

    expect(await contextFit.fitContextSizes()).toBe(0);
    expect((await sizeOf(recent.id)).contextTokens).toBe(1_000_000);
    expect((await sizeOf(stale.id)).contextTokens).toBe(1_000_000);
  });

  it("a conversation it kept is not read again until another turn finishes", async () => {
    const agentId = await seedAgent("checked");
    const { id } = await seedConversation(agentId);
    // Four full turns: one short of the evidence the rule needs.
    await seedTurns(id, repeat(190_000, 4), { endingMinutesAgo: 10 });

    expect(await contextFit.fitContextSizes()).toBe(0);
    const checked = await db.conversation.findUniqueOrThrow({
      where: { id },
      select: { contextFitCheckedAt: true },
    });
    // The stamp is the newest finished turn the look covered, not the
    // job's own clock.
    const newest = await db.turn.findFirstOrThrow({
      where: { conversationId: id },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    });
    expect(checked.contextFitCheckedAt).toEqual(newest.finishedAt);

    // Nothing new: the next pass does not even consider it (the stamp holds).
    expect(await contextFit.fitContextSizes()).toBe(0);
    expect(
      (
        await db.conversation.findUniqueOrThrow({
          where: { id },
          select: { contextFitCheckedAt: true },
        })
      ).contextFitCheckedAt,
    ).toEqual(checked.contextFitCheckedAt);

    // The fifth full turn finishes: now it is read again, and grows.
    await seedTurns(id, [190_000], { endingMinutesAgo: 0 });
    expect(await contextFit.fitContextSizes()).toBe(1);
    expect((await sizeOf(id)).contextTokens).toBe(1_000_000);
  });

  it("a turn already running when the size changed is no evidence about the new size", async () => {
    // Changed 40 min ago (out of cooldown). Ten small turns FINISHED after
    // the change but were all CREATED before it, so they ran at the old
    // size and must not shrink the new one.
    const agentId = await seedAgent("inflight");
    const changedAt = minutesAgo(40);
    const { id } = await seedConversation(agentId, {
      contextTokens: 1_000_000,
      changedAt,
    });
    for (let i = 0; i < 10; i += 1) {
      await db.turn.create({
        data: {
          conversationId: id,
          message: `m${i}`,
          source: "web",
          status: "done",
          createdAt: minutesAgo(50 + i),
          finishedAt: minutesAgo(30 - i),
          usage: { inputTokens: 1_000, outputTokens: 10, promptTokens: 1_000 },
        },
      });
    }
    expect(await contextFit.fitContextSizes()).toBe(0);
    expect((await sizeOf(id)).contextTokens).toBe(1_000_000);
  });

  it("more candidates than one pass holds: the longest-waiting go first, and the rest follow on the next pass", async () => {
    const agentId = await seedAgent("backlog");
    // 51 conversations that each earned a grow, one more than a pass holds.
    // The oldest finished its turns an hour ago; the rest just now.
    const oldest = await seedConversation(agentId);
    await seedTurns(oldest.id, repeat(190_000, 5), { endingMinutesAgo: 60 });
    const rest: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const { id } = await seedConversation(agentId);
      await seedTurns(id, repeat(190_000, 5), { endingMinutesAgo: 1 });
      rest.push(id);
    }

    expect(await contextFit.fitContextSizes()).toBe(50);
    // The oldest was not crowded out by the busier ones.
    expect((await sizeOf(oldest.id)).contextTokens).toBe(1_000_000);

    expect(await contextFit.fitContextSizes()).toBe(1);
    const sized = await db.conversation.count({
      where: { id: { in: rest }, contextTokens: 1_000_000 },
    });
    expect(sized).toBe(50);
  });

  it("never sizes an automation, pair or eval conversation", async () => {
    const agentId = await seedAgent("sources");
    for (const source of ["cron", "agent", "eval", "memory_review"]) {
      const { id } = await seedConversation(agentId, { source });
      await seedTurns(id, repeat(190_000, 5));
    }
    expect(await contextFit.fitContextSizes()).toBe(0);
  });

  it("a write decided from a stale read changes nothing and audits nothing", async () => {
    // The race made deterministic: two passes read the SAME row, the first
    // writes, the second's write must find the row moved and stand down.
    const agentId = await seedAgent("stale");
    const { id } = await seedConversation(agentId);
    const now = new Date();
    const read: import("./context-fit-service").CandidateRow = {
      conversation_id: id,
      workspace_id: WORKSPACE,
      organization_id: ORG,
      context_tokens: null,
      context_tokens_changed_at: null,
      last_finished_at: now,
    };

    expect(await contextFit.applySize(read, null, 1_000_000, now)).toBe(true);
    expect(await contextFit.applySize(read, null, 100_000, now)).toBe(false);

    expect((await sizeOf(id)).contextTokens).toBe(1_000_000);
    expect(
      await db.auditLog.count({
        where: { organizationId: ORG, serviceActor: "context-fit" },
      }),
    ).toBe(1);
  });

  it("one tenant's pass changes only its own conversations, and audits into its own org", async () => {
    const mine = await seedAgent("tenant-a");
    const theirs = await seedAgent("tenant-b", OTHER_WORKSPACE);
    const a = await seedConversation(mine);
    await seedTurns(a.id, repeat(190_000, 5));
    const b = await seedConversation(theirs);
    await seedTurns(b.id, repeat(50_000, 5));

    await contextFit.fitContextSizes();

    expect((await sizeOf(a.id)).contextTokens).toBe(1_000_000);
    expect((await sizeOf(b.id)).contextTokens).toBeNull();
    // The audit row carries the CHANGED conversation's own org, never the
    // other tenant's (which has no owner here, so a misrouted row would be
    // dropped, not land: assert presence in the right org instead).
    const rows = await db.auditLog.findMany({
      where: { serviceActor: "context-fit" },
      select: { organizationId: true, workspaceId: true },
    });
    expect(rows).toEqual([{ organizationId: ORG, workspaceId: WORKSPACE }]);
  });

  it("the next turn's claim carries the conversation's size", async () => {
    const agentId = await seedAgent("claim");
    const { id } = await seedConversation(agentId, {
      contextTokens: 1_000_000,
    });
    await db.turn.create({
      data: {
        conversationId: id,
        message: "next",
        source: "web",
        status: "queued",
      },
    });

    const claimed = await dueWork.claimDueWork(RUNNER, 10);
    const turn = claimed.find((d) => d.kind === "turn");
    expect(turn).toMatchObject({ kind: "turn", contextTokens: 1_000_000 });
  });

  describe("the trial-credit limit at dispatch", () => {
    const trial = (limit: number | undefined) =>
      platformLlm.initPlatformLlm({
        trialCreditApplies: () => true,
        ...(limit !== undefined && { trialMaxContextTokens: limit }),
      });

    it("a trial-credit agent's 1M conversation ships at the limit", async () => {
      trial(200_000);
      const agentId = await seedAgent("trial", WORKSPACE, { withKey: false });
      expect(
        await llmCredential.deliveredContextTokens(agentId, 1_000_000),
      ).toBe(200_000);
      // Below the limit passes through; no size of its own stays absent.
      expect(await llmCredential.deliveredContextTokens(agentId, 100_000)).toBe(
        100_000,
      );
      expect(
        await llmCredential.deliveredContextTokens(agentId, undefined),
      ).toBeUndefined();
    });

    it("the agent's own key lifts the limit, with no other change", async () => {
      trial(200_000);
      const agentId = await seedAgent("ownkey");
      expect(
        await llmCredential.deliveredContextTokens(agentId, 1_000_000),
      ).toBe(1_000_000);
    });

    it("the hosted platform's own provider: a trial agent's 1M conversation ships at 200k", async () => {
      // The real licensed provider and its real eligibility rule (env key
      // configured, empty pool, a trusted owner), not a stub: what the
      // hosted deployment injects at boot.
      const { eePlatformLlm } = await import("../ee/services/platform-llm");
      const saved = process.env.PLATFORM_ANTHROPIC_API_KEY;
      process.env.PLATFORM_ANTHROPIC_API_KEY = "sk-ant-api03-platform-proof";
      try {
        platformLlm.initPlatformLlm(eePlatformLlm);
        const trialAgent = await seedAgent("ee-trial", WORKSPACE, {
          withKey: false,
        });
        expect(
          await llmCredential.deliveredContextTokens(trialAgent, 1_000_000),
        ).toBe(200_000);
      } finally {
        if (saved === undefined) delete process.env.PLATFORM_ANTHROPIC_API_KEY;
        else process.env.PLATFORM_ANTHROPIC_API_KEY = saved;
      }
    });

    it("the hosted provider gives a workspace with its own key no limit", async () => {
      const { eePlatformLlm } = await import("../ee/services/platform-llm");
      const saved = process.env.PLATFORM_ANTHROPIC_API_KEY;
      process.env.PLATFORM_ANTHROPIC_API_KEY = "sk-ant-api03-platform-proof";
      try {
        platformLlm.initPlatformLlm(eePlatformLlm);
        const keyed = await seedAgent("ee-keyed");
        expect(
          await llmCredential.deliveredContextTokens(keyed, 1_000_000),
        ).toBe(1_000_000);
      } finally {
        if (saved === undefined) delete process.env.PLATFORM_ANTHROPIC_API_KEY;
        else process.env.PLATFORM_ANTHROPIC_API_KEY = saved;
      }
    });

    it("no deployment limit (every self-host) means no limit", async () => {
      trial(undefined);
      const agentId = await seedAgent("nolimit", WORKSPACE, { withKey: false });
      expect(
        await llmCredential.deliveredContextTokens(agentId, 1_000_000),
      ).toBe(1_000_000);
    });
  });
});
