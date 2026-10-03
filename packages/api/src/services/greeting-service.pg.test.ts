import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * THE AGENT SPEAKS FIRST — on real PostgreSQL.
 *
 * The laws a mock cannot show:
 *
 * - **Only the ONBOARDING agent is greeted.** The greeting is a first-run
 *   moment, not a property of opening a thread. Every agent a person creates
 *   later from the dashboard opens its thread through the same door, and the
 *   fence that tells them apart is the onboarding survey's own record of what
 *   the flow created — for the person who created it.
 * - **One greeting, ever.** The fence is "no turns at all": a second open of
 *   the same thread (refresh, second tab, returning user) posts nothing.
 * - **A keyed agent is asked to greet live**: a `queued` turn, source
 *   `greeting`, no user, carrying the instruction — the exact shape the
 *   dispatcher hands to the sandbox.
 * - **A keyless agent is not greeted at all**: no words the agent never said,
 *   and no failure card as the first thing in the product. The web renders
 *   its empty-thread welcome in the PRODUCT's voice instead.
 * - **Nothing else greets**: a thread that already has a human turn is left
 *   alone, and the greeting never fires outside a direct thread.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Conversations = typeof import("./conversation-service");
type Greeting = typeof import("./greeting-service");

let db: Db;
let conversations: Conversations;
let greeting: Greeting;

const P = "grt-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const USER = `${P}user`;
/** A second workspace member — the colleague who must never be greeted. */
const OTHER_USER = `${P}other`;

const reset = async () => {
  await db.policyRuleTarget.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleIdentity.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleV2.deleteMany({ where: { logicalId: { startsWith: P } } });
  await db.secret.deleteMany({ where: { name: { startsWith: P } } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.onboardingSurvey.deleteMany({
    where: { workspaceId: { startsWith: P } },
  });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

/**
 * Record an agent as the one THIS user created during onboarding — the exact
 * write `completeOnboarding` performs (`responses.createdAgentId` on the
 * workspace's survey) before the flow navigates into the chat.
 */
const recordOnboardingAgent = async (agentId: string, userId = USER) => {
  await db.onboardingSurvey.upsert({
    where: { workspaceId: WORKSPACE },
    create: {
      workspaceId: WORKSPACE,
      userId,
      userEmail: `${userId}@example.com`,
      responses: { createdAgentId: agentId },
    },
    update: { userId, responses: { createdAgentId: agentId } },
  });
};

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

/**
 * A hosted agent. `onboarding` defaults to TRUE — these suites are about the
 * greeting, whose subject is the onboarding agent, so the interesting variable
 * in most cases is the model key. The onboarding fence gets its own explicit
 * negatives below.
 */
const seedAgent = async (
  suffix: string,
  options: { withKey: boolean; onboarding?: boolean },
) => {
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
  if (options.withKey) await grantLlmKey(agent.id, suffix);
  if (options.onboarding !== false) await recordOnboardingAgent(agent.id);
  return agent.id;
};

const turnsOf = (conversationId: string) =>
  db.turn.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    select: { source: true, status: true, userId: true, message: true },
  });

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.GATEWAY_CA_CERT =
    "-----BEGIN CERTIFICATE-----\npg-proof-fake-ca\n-----END CERTIFICATE-----";

  ({ db } = await import("@onecli/db"));
  conversations = await import("./conversation-service");
  greeting = await import("./greeting-service");

  await reset();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Greeting Workspace", organizationId: ORG },
  });
  await db.user.create({
    data: {
      id: USER,
      email: `${USER}@example.com`,
      externalAuthId: USER,
      name: "Tomer Levi",
    },
  });
  await db.user.create({
    data: {
      id: OTHER_USER,
      email: `${OTHER_USER}@example.com`,
      externalAuthId: OTHER_USER,
      name: "Dana Cohen",
    },
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  // Each test declares the onboarding truth it needs (`seedAgent` records it,
  // the negatives below override or remove it), so the survey starts empty —
  // no test inherits another's.
  await db.onboardingSurvey.deleteMany({
    where: { workspaceId: { startsWith: P } },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

describe.skipIf(!PROOF_URL)("the agent speaks first (pg)", () => {
  it("asks a keyed agent to greet live: one queued greeting turn, no user, first name in the instruction", async () => {
    const agentId = await seedAgent("keyed", { withKey: true });
    const thread = await conversations.ensureDirectConversation(
      WORKSPACE,
      agentId,
      USER,
    );

    await greeting.greetEmptyDirectThread(WORKSPACE, thread, USER);

    const turns = await turnsOf(thread.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      source: "greeting",
      status: "queued",
      userId: null,
    });
    expect(turns[0]!.message).toContain("Tomer");
    expect(turns[0]!.message).not.toContain("Levi");
  });

  it("says NOTHING for a keyless agent: no greeting it cannot answer, no canned words in its bubble", async () => {
    // A greeting exists to be ANSWERED. An agent with no model key cannot
    // answer one, and the two alternatives are both worse than silence:
    // a turn that fails coded `no_model_key` opens the product with a
    // failure card, and a pre-written "done" turn puts words the agent
    // never said into the agent's own bubble. The web renders its
    // empty-thread welcome instead, in the product's voice.
    const agentId = await seedAgent("keyless", { withKey: false });
    const thread = await conversations.ensureDirectConversation(
      WORKSPACE,
      agentId,
      USER,
    );

    await greeting.greetEmptyDirectThread(WORKSPACE, thread, USER);

    expect(await turnsOf(thread.id)).toHaveLength(0);
    expect(
      await db.turnEvent.count({ where: { conversationId: thread.id } }),
    ).toBe(0);
  });

  it("greets ONCE: a second open of the same thread posts nothing", async () => {
    const agentId = await seedAgent("twice", { withKey: true });
    const thread = await conversations.ensureDirectConversation(
      WORKSPACE,
      agentId,
      USER,
    );

    await greeting.greetEmptyDirectThread(WORKSPACE, thread, USER);
    await greeting.greetEmptyDirectThread(WORKSPACE, thread, USER);

    expect(await turnsOf(thread.id)).toHaveLength(1);
  });

  it("greets ONCE under CONCURRENCY: parallel opens of the same thread still post one turn", async () => {
    // The thread-open door is a PUT that React Query re-runs on a StrictMode
    // double-invoke, a refetch, or a second tab, so this race is ordinary
    // rather than exotic.
    //
    // MEASURED (this schema, 5 parallel inserts on one conversation): the
    // partial unique index `turns_one_active_per_conversation` admits 1 of 5
    // `queued` rows — so for the live greeting the index alone would already
    // hold. It admits 5 of 5 `done` rows, because its predicate covers only
    // ACTIVE statuses. That is why the PR's original keyless path (a turn
    // born `done`) could post duplicate greetings, and why the claim below
    // is written as `INSERT … WHERE NOT EXISTS` rather than leaning on the
    // index: the fence belongs to the greeting, not to the status it
    // happens to be born in.
    const agentId = await seedAgent("parallel", { withKey: true });
    const thread = await conversations.ensureDirectConversation(
      WORKSPACE,
      agentId,
      USER,
    );

    await Promise.all(
      Array.from({ length: 5 }, () =>
        greeting.greetEmptyDirectThread(WORKSPACE, thread, USER),
      ),
    );

    expect(await turnsOf(thread.id)).toHaveLength(1);
  });

  it("leaves a thread that already has a turn alone", async () => {
    const agentId = await seedAgent("spoken", { withKey: true });
    const thread = await conversations.ensureDirectConversation(
      WORKSPACE,
      agentId,
      USER,
    );
    await db.turn.create({
      data: {
        conversationId: thread.id,
        message: "hello there",
        status: "done",
        source: "web",
        userId: USER,
      },
    });

    await greeting.greetEmptyDirectThread(WORKSPACE, thread, USER);

    const turns = await turnsOf(thread.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.source).toBe("web");
  });

  it("never greets outside a direct thread", async () => {
    const agentId = await seedAgent("group", { withKey: true });
    const group = await conversations.createConversation(WORKSPACE, {
      agentId,
    });

    await greeting.greetEmptyDirectThread(WORKSPACE, group, USER);

    expect(await turnsOf(group.id)).toHaveLength(0);
  });

  describe("only the ONBOARDING agent is greeted", () => {
    it("says nothing in a DASHBOARD-created agent's first thread", async () => {
      // THE BUG THIS FENCE CLOSES. The greeting shipped on the thread-open
      // door with no notion of onboarding, so the fifth agent someone makes
      // on a Tuesday opened its chat and was told to message them. A welcome
      // nobody asked for is not a welcome.
      //
      // Everything else here is identical to the passing case above — same
      // workspace, same user, same model key, same empty direct thread. The
      // ONLY difference is that the onboarding survey doesn't name this agent.
      const onboardingAgent = await seedAgent("onboarded", { withKey: true });
      const dashboardAgent = await seedAgent("dashboard", {
        withKey: true,
        onboarding: false,
      });
      // The survey still names the onboarding agent — this is a real, used
      // workspace, not one that never onboarded.
      await recordOnboardingAgent(onboardingAgent);

      const thread = await conversations.ensureDirectConversation(
        WORKSPACE,
        dashboardAgent,
        USER,
      );

      await greeting.greetEmptyDirectThread(WORKSPACE, thread, USER);

      expect(await turnsOf(thread.id)).toHaveLength(0);
    });

    it("says nothing to a COLLEAGUE opening their own thread with the onboarding agent", async () => {
      // Direct threads are per-user: every workspace member gets their own
      // private thread with an agent, each of which starts empty. Without the
      // user half of the fence, the second person to open the onboarding
      // agent would be greeted as if they had just signed up — an agent
      // messaging a colleague unprompted, months later.
      const agentId = await seedAgent("colleague", { withKey: true });

      const theirThread = await conversations.ensureDirectConversation(
        WORKSPACE,
        agentId,
        OTHER_USER,
      );

      await greeting.greetEmptyDirectThread(WORKSPACE, theirThread, OTHER_USER);

      expect(await turnsOf(theirThread.id)).toHaveLength(0);
    });

    it("says nothing in a workspace that never onboarded (no survey at all)", async () => {
      // Pre-onboarding workspaces and self-hosts that came in another way
      // have no survey row. Absence means "the flow created nothing here",
      // never "greet anything".
      const agentId = await seedAgent("nosurvey", {
        withKey: true,
        onboarding: false,
      });
      await db.onboardingSurvey.deleteMany({
        where: { workspaceId: WORKSPACE },
      });

      const thread = await conversations.ensureDirectConversation(
        WORKSPACE,
        agentId,
        USER,
      );

      await greeting.greetEmptyDirectThread(WORKSPACE, thread, USER);

      expect(await turnsOf(thread.id)).toHaveLength(0);
    });
  });

  it("bounds the name it splices into the model instruction", async () => {
    // `updateProfile` accepts 1..255 chars of anything, and that string
    // lands inside platform-authored text the model reads. Control
    // characters are stripped and the first name is capped.
    const noisy = `${"A".repeat(200)}\u0007 Levi`;
    await db.user.update({ where: { id: USER }, data: { name: noisy } });
    try {
      const agentId = await seedAgent("noisy", { withKey: true });
      const thread = await conversations.ensureDirectConversation(
        WORKSPACE,
        agentId,
        USER,
      );

      await greeting.greetEmptyDirectThread(WORKSPACE, thread, USER);

      const [turn] = await turnsOf(thread.id);
      expect(turn!.message).not.toContain("\u0007");
      expect(turn!.message).not.toContain("A".repeat(41));
    } finally {
      await db.user.update({
        where: { id: USER },
        data: { name: "Tomer Levi" },
      });
    }
  });
});
