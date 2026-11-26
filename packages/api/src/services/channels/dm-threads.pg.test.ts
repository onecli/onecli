import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { proofDatabaseUrl } from "../../testing/pg-proof";

/**
 * A thread opened inside a Slack DM is its own conversation, run beside the
 * DM's top level (the person's one direct conversation, shared with the
 * web chat) instead of joining whatever that is doing. Proven at the level
 * the bugs live: which conversation a threaded DM reply lands in, who may
 * read it (conversations AND runs), what the first turn of the thread
 * forks from, and how many of an agent's person turns run at once.
 *
 * Driven through the real DM door (`ingestDirectMessage`) and the real
 * claim (`claimDueWork`), over PostgreSQL, so the per-user direct index,
 * the sourced-conversation unique, and the one-active-turn index all take
 * part.
 */

const PROOF_URL = proofDatabaseUrl();
const P = "dmt-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OWNER = `${P}owner`;
const MEMBER = `${P}member`;
const OTHER = `${P}other`;
const OWNER_SLACK = "U0DMTOWNER";
const MEMBER_SLACK = "U0DMTMEMBER";
const OTHER_SLACK = "U0DMTOTHER";
const MEMBER_IM = "D0DMTMEMBER";
const RUNNER = `${P}runner`;

let db: typeof import("@onecli/db").db;
let ingestion: typeof import("./channel-ingestion-service");
let conversations: typeof import("../conversation-service");
let dueWork: typeof import("../due-work");
let runs: typeof import("../agent-runs-service");
let providers: typeof import("../../providers");

let integrationId: string;
let eventSeq = 0;
const nextEvent = () => `Ev-${P}${++eventSeq}`;

interface Stage {
  agentId: string;
  presenceId: string;
  sandboxId: string;
}

/** Copied law from conversation.pg.test.ts: a hosted agent needs an
 * injectable LLM key or door 1 fails its turns outright. */
const grantLlmKey = async (agentId: string, suffix: string) => {
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
      identities: { create: [{ agentId }] },
      targets: { create: [{ kind: "secret", secretId: secret.id }] },
    },
  });
};

const seedStage = async (suffix: string): Promise<Stage> => {
  const agent = await db.agent.create({
    data: {
      identifier: `${P}agent-${suffix}`,
      name: "Kai",
      workspaceId: WORKSPACE,
      accessToken: `aoc_${P}${suffix}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  await grantLlmKey(agent.id, suffix);
  const credentials = await providers
    .getCrypto()
    .encrypt(JSON.stringify({ botToken: `xoxb-${suffix}` }));
  const presence = await db.agentChannel.create({
    data: {
      agentId: agent.id,
      integrationId,
      provider: "slack",
      externalId: `A0${suffix}`,
      identityRef: "U0DMTBOT",
      transport: "socket",
      status: "active",
      credentials,
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
      homeAppliedGeneration: 1,
      lastActiveAt: new Date(),
    },
  });
  return { agentId: agent.id, presenceId: presence.id, sandboxId };
};

/** A member's message in their DM with the agent: at the top level, or
 * inside a thread of it (`threadTs`). */
const dm = (
  stage: Stage,
  text: string,
  options: { threadTs?: string; from?: string } = {},
) =>
  ingestion.ingestDirectMessage({
    agentChannelId: stage.presenceId,
    externalUserId: options.from ?? MEMBER_SLACK,
    externalThreadId: MEMBER_IM,
    text,
    ...(options.threadTs && {
      sourceThreadId: options.threadTs,
      threadExternalId: `${MEMBER_IM}:${options.threadTs}`,
    }),
    eventId: nextEvent(),
  });

const turnOf = (outcome: Awaited<ReturnType<typeof dm>>) => {
  if (outcome.kind !== "turn" && outcome.kind !== "followUp") {
    throw new Error(`expected a turn, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
};

const claimedTurns = async () =>
  (await dueWork.claimDueWork(RUNNER, 10)).flatMap((w) =>
    w.kind === "turn" ? [w] : [],
  );

const reset = async () => {
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.policyRuleV2.deleteMany({ where: { logicalId: { startsWith: P } } });
  await db.secret.deleteMany({ where: { name: { startsWith: P } } });
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

  ({ db } = await import("@onecli/db"));
  const { ensureEditionDefaults } = await import("../../edition-defaults");
  ensureEditionDefaults();
  providers = await import("../../providers");
  ingestion = await import("./channel-ingestion-service");
  conversations = await import("../conversation-service");
  dueWork = await import("../due-work");
  runs = await import("../agent-runs-service");

  await reset();
  await db.runner.deleteMany({ where: { id: RUNNER } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "DM threads", organizationId: ORG },
  });
  await db.runner.create({
    data: { id: RUNNER, name: "runner", token: `rnr_${P}` },
  });
  integrationId = (
    await db.channelIntegration.create({
      data: {
        organizationId: ORG,
        provider: "slack",
        externalId: "T0DMT",
        name: "DMT Slack",
      },
      select: { id: true },
    })
  ).id;
  for (const [id, name, role, slack] of [
    [OWNER, "Olive Owner", "owner", OWNER_SLACK],
    [MEMBER, "Mia Member", "member", MEMBER_SLACK],
    [OTHER, "Omar Other", "member", OTHER_SLACK],
  ] as const) {
    await db.user.create({
      data: { id, email: `${id}@example.com`, externalAuthId: id, name },
    });
    await db.organizationMember.create({
      data: {
        organizationId: ORG,
        userId: id,
        userEmail: `${id}@example.com`,
        role: "member",
      },
    });
    await db.workspaceAccess.create({
      data: { workspaceId: WORKSPACE, userId: id, role },
    });
    await db.channelUserLink.create({
      data: {
        integrationId,
        externalUserId: slack,
        userId: id,
        linkedVia: "manual",
      },
    });
  }
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await reset();
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.runner.deleteMany({ where: { id: RUNNER } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
});

describe.skipIf(!PROOF_URL)(
  "a thread inside a DM is its own conversation",
  () => {
    it("a top-level DM lands in the person's direct conversation; a thread reply opens a second, sourced one owned by them", async () => {
      const stage = await seedStage("route");
      const top = turnOf(await dm(stage, "research gifts"));
      const thread = turnOf(
        await dm(stage, "so let's do that this week", { threadTs: "100.1" }),
      );

      expect(thread.conversationId).not.toBe(top.conversationId);
      // Not a follow-up into the running top-level turn: a turn of its own.
      expect(thread.kind).toBe("turn");

      const rows = await db.conversation.findMany({
        where: { agentId: stage.agentId },
        select: { id: true, direct: true, userId: true, externalRef: true },
        orderBy: { createdAt: "asc" },
      });
      expect(rows).toEqual([
        {
          id: top.conversationId,
          direct: true,
          userId: MEMBER,
          externalRef: null,
        },
        {
          id: thread.conversationId,
          direct: false,
          userId: MEMBER,
          externalRef: `${MEMBER_IM}:100.1`,
        },
      ]);
      // The one-direct-row-per-user invariant is untouched: the thread is
      // sourced, so a second thread never collides with the direct index.
      const second = turnOf(await dm(stage, "and this", { threadTs: "100.2" }));
      expect(second.conversationId).not.toBe(thread.conversationId);
      expect(second.conversationId).not.toBe(top.conversationId);
    });

    it("the thread's link is `direct` (the IM is where replies post) under the thread's own address, beside the DM's bare link", async () => {
      const stage = await seedStage("link");
      const top = turnOf(await dm(stage, "hi"));
      const thread = turnOf(
        await dm(stage, "in a thread", { threadTs: "200.1" }),
      );
      const links = await db.channelThreadLink.findMany({
        where: { agentChannelId: stage.presenceId },
        select: {
          conversationId: true,
          externalThreadId: true,
          kind: true,
          externalUserId: true,
        },
        orderBy: { createdAt: "asc" },
      });
      expect(links).toEqual([
        {
          conversationId: top.conversationId,
          externalThreadId: MEMBER_IM,
          kind: "direct",
          externalUserId: MEMBER_SLACK,
        },
        {
          conversationId: thread.conversationId,
          externalThreadId: `${MEMBER_IM}:200.1`,
          kind: "direct",
          externalUserId: MEMBER_SLACK,
        },
      ]);
      // The turn still says where in the IM the answer is owed.
      const turn = await db.turn.findUniqueOrThrow({
        where: { id: thread.turn.id },
        select: { sourceThreadId: true },
      });
      expect(turn.sourceThreadId).toBe("200.1");
    });

    it("a second message in the same thread continues that thread's conversation (and joins its running turn)", async () => {
      const stage = await seedStage("same");
      const first = turnOf(await dm(stage, "one", { threadTs: "300.1" }));
      await db.turn.update({
        where: { id: first.turn.id },
        data: { status: "running" },
      });
      const next = await dm(stage, "two", { threadTs: "300.1" });
      expect(next.kind).toBe("followUp");
      if (next.kind !== "followUp") throw new Error("unreachable");
      expect(next.conversationId).toBe(first.conversationId);
      expect(next.turn.followUpOfTurnId).toBe(first.turn.id);
    });

    it("a thread runs while the DM's top level is busy: the top-level turn is running and the thread still gets a turn of its own", async () => {
      const stage = await seedStage("beside");
      const top = turnOf(await dm(stage, "long task"));
      await db.turn.update({
        where: { id: top.turn.id },
        data: { status: "running" },
      });
      const thread = await dm(stage, "meanwhile", { threadTs: "400.1" });
      // Before: a follow-up folded into the running top-level turn. Now: a
      // turn in the thread's own conversation, queued to run beside it.
      expect(thread.kind).toBe("turn");
      if (thread.kind !== "turn") throw new Error("unreachable");
      expect(thread.turn.followUpOfTurnId).toBeNull();
      expect(thread.turn.status).toBe("queued");
    });

    it("PRIVACY: the thread conversation is visible to its owner alone, like their direct thread", async () => {
      const stage = await seedStage("privacy");
      const thread = turnOf(await dm(stage, "private", { threadTs: "500.1" }));
      const mine = await conversations.listConversations(
        WORKSPACE,
        MEMBER,
        stage.agentId,
      );
      expect(mine.map((c) => c.id)).toContain(thread.conversationId);
      const theirs = await conversations.listConversations(
        WORKSPACE,
        OTHER,
        stage.agentId,
      );
      expect(theirs.map((c) => c.id)).not.toContain(thread.conversationId);
      await expect(
        conversations.requireConversation(
          WORKSPACE,
          thread.conversationId,
          OTHER,
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("PRIVACY, in Runs: the thread's turn is the owner's to see and nobody else's (no role enforcement: no admin override)", async () => {
      // The Runs view fences on the same owner rule as conversations. A DM
      // thread is sourced, so a fence keyed on `direct` would have listed it
      // to the whole workspace as a channel thread: this pins the owner key.
      const stage = await seedStage("runs");
      const thread = turnOf(
        await dm(stage, "for my eyes", { threadTs: "550.1" }),
      );
      const mine = await runs.listRuns(WORKSPACE, ORG, MEMBER, stage.agentId);
      expect(mine.runs.map((r) => r.turnId)).toContain(thread.turn.id);
      const theirs = await runs.listRuns(WORKSPACE, ORG, OTHER, stage.agentId);
      expect(theirs.runs.map((r) => r.turnId)).not.toContain(thread.turn.id);
      await expect(
        runs.getRun(WORKSPACE, ORG, OTHER, stage.agentId, thread.turn.id),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("FENCE: a thread address already owned by someone else reads NOT_FOUND, never a shared conversation", async () => {
      const stage = await seedStage("fence");
      await db.conversation.create({
        data: {
          agentId: stage.agentId,
          source: "slack",
          externalRef: `${MEMBER_IM}:600.1`,
          userId: OTHER,
        },
      });
      await expect(
        conversations.ensureDirectThreadConversation(
          WORKSPACE,
          stage.agentId,
          MEMBER,
          { source: "slack", externalRef: `${MEMBER_IM}:600.1` },
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("DOORS: the platform's generic door refuses the thread (it is private), the wake door admits it (it is the owner's)", async () => {
      // The two platform doors are keyed on OWNERSHIP, not on `direct`: a
      // cron-style write through the system door must not land in a DM
      // thread (it would speak as the platform in someone's private
      // thread), while a sanctioned wake (watch fire, approval resume) must
      // reach it exactly like the direct thread.
      const stage = await seedStage("doors");
      const thread = turnOf(await dm(stage, "doors", { threadTs: "650.1" }));
      await expect(
        conversations.requireSystemConversation(
          WORKSPACE,
          thread.conversationId,
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        conversations.requireDirectWakeConversation(
          WORKSPACE,
          thread.conversationId,
          stage.agentId,
        ),
      ).resolves.toMatchObject({ id: thread.conversationId, userId: MEMBER });
    });
  },
);

describe.skipIf(!PROOF_URL)(
  "the thread's first turn forks the DM's session",
  () => {
    it("dispatch carries the owner's direct conversation's session as the fork parent, once: only while the thread has no session", async () => {
      const stage = await seedStage("fork");
      const top = turnOf(await dm(stage, "hello"));
      await db.turn.update({
        where: { id: top.turn.id },
        data: { status: "done" },
      });
      await db.conversation.update({
        where: { id: top.conversationId },
        data: { harnessSessionRef: "sess-parent" },
      });
      const thread = turnOf(await dm(stage, "branch", { threadTs: "700.1" }));

      const [claimed] = await claimedTurns();
      expect(claimed).toMatchObject({
        turnId: thread.turn.id,
        conversationId: thread.conversationId,
        resumeSessionRef: null,
        forkSessionRef: "sess-parent",
      });

      // The thread now has a session of its own: the next turn resumes it and
      // never forks again.
      await db.turn.update({
        where: { id: thread.turn.id },
        data: { status: "done" },
      });
      await db.conversation.update({
        where: { id: thread.conversationId },
        data: { harnessSessionRef: "sess-child" },
      });
      const again = turnOf(await dm(stage, "more", { threadTs: "700.1" }));
      const [next] = await claimedTurns();
      expect(next).toMatchObject({
        turnId: again.turn.id,
        resumeSessionRef: "sess-child",
      });
      expect(next).not.toHaveProperty("forkSessionRef");
    });

    it("no parent session yet (the DM never ran): the thread starts fresh, with nothing to fork", async () => {
      const stage = await seedStage("fresh");
      turnOf(await dm(stage, "top"));
      const thread = turnOf(await dm(stage, "thread", { threadTs: "800.1" }));
      const claimed = await claimedTurns();
      const own = claimed.find((c) => c.turnId === thread.turn.id);
      expect(own).toBeDefined();
      expect(own).not.toHaveProperty("forkSessionRef");
    });

    it("a direct conversation itself never forks: it is the parent, not a child", async () => {
      const stage = await seedStage("noself");
      const top = turnOf(await dm(stage, "top"));
      const [claimed] = await claimedTurns();
      expect(claimed?.turnId).toBe(top.turn.id);
      expect(claimed).not.toHaveProperty("forkSessionRef");
    });
  },
);

describe.skipIf(!PROOF_URL)("the per-agent cap on person turns", () => {
  const seedTurn = async (
    agentId: string,
    ref: string,
    data: { status: string; source: string; createdAt?: Date },
  ) => {
    const conversation = await db.conversation.create({
      data: {
        agentId,
        source: data.source === "cron" ? "cron" : "slack",
        externalRef: `${P}${ref}`,
      },
      select: { id: true },
    });
    return db.turn.create({
      data: {
        conversationId: conversation.id,
        message: ref,
        status: data.status,
        source: data.source,
        ...(data.source !== "cron" && { userId: MEMBER }),
        ...(data.createdAt && { createdAt: data.createdAt }),
      },
      select: { id: true },
    });
  };

  it(`claims at most ${3} person turns per agent across its conversations; the rest wait in arrival order`, async () => {
    const stage = await seedStage("cap");
    const queued = [];
    for (let i = 0; i < 5; i++) {
      queued.push(
        await seedTurn(stage.agentId, `q${i}`, {
          status: "queued",
          source: "slack",
          createdAt: new Date(Date.now() - (50 - i) * 1000),
        }),
      );
    }
    const first = await claimedTurns();
    expect(first.map((c) => c.turnId)).toEqual(
      queued.slice(0, dueWork.MAX_PERSON_TURNS_PER_AGENT).map((t) => t.id),
    );
    // Nothing more while the three run.
    expect(await claimedTurns()).toEqual([]);
    // One finishes: exactly one slot frees, and the oldest waiter takes it.
    await db.turn.update({
      where: { id: queued[0]!.id },
      data: { status: "done" },
    });
    const next = await claimedTurns();
    expect(next.map((c) => c.turnId)).toEqual([queued[3]!.id]);
  });

  it("platform runs neither take a person's slot nor wait for one", async () => {
    const stage = await seedStage("cap-cron");
    for (let i = 0; i < 3; i++) {
      await seedTurn(stage.agentId, `run${i}`, {
        status: "running",
        source: "slack",
      });
    }
    const cron = await seedTurn(stage.agentId, "cron", {
      status: "queued",
      source: "cron",
    });
    const person = await seedTurn(stage.agentId, "late", {
      status: "queued",
      source: "slack",
    });
    const claimed = await claimedTurns();
    expect(claimed.map((c) => c.turnId)).toEqual([cron.id]);
    expect(claimed.map((c) => c.turnId)).not.toContain(person.id);
  });

  it("the cap is per agent: another agent's running turns never hold this one back", async () => {
    const busy = await seedStage("cap-busy");
    const idle = await seedStage("cap-idle");
    for (let i = 0; i < 3; i++) {
      await seedTurn(busy.agentId, `b${i}`, {
        status: "running",
        source: "slack",
      });
    }
    const mine = await seedTurn(idle.agentId, "mine", {
      status: "queued",
      source: "slack",
    });
    const claimed = await claimedTurns();
    expect(claimed.map((c) => c.turnId)).toEqual([mine.id]);
  });
});
