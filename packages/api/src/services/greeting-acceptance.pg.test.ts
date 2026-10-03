/**
 * ACCEPTANCE: what a new user's thread actually contains.
 *
 * Every other suite around the greeting mocks something — the route tests
 * mock the services, the service tests call the service directly. This one
 * mocks NOTHING below the wire: it builds the real `createApiApp`, drives the
 * real `PUT /v1/agents/:id/conversations/direct` door with a real org API key
 * against a real PostgreSQL, and then reads the thread back through the real
 * `GET /v1/conversations/:id/turns` the web client calls.
 *
 * It exists because the bug this PR fixes was never visible in a unit: it was
 * a property of what the door LEAVES BEHIND for the next request to find.
 *
 * It now also pins WHO gets greeted: the agent onboarding created, and only
 * that one. An agent made later from the dashboard opens the same door, over
 * the same wire, and must come back to silence.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;

let db: Db;
let app: ReturnType<typeof import("../app").createApiApp>;

/** The session slot — the web's own auth shape (scope "session"). The
 * greeting is a dashboard product moment, so the suite drives it the way the
 * dashboard does; the org API key below exists to prove the NEGATIVE (a
 * program's call must not be greeted). */
let currentSession: { id: string; email: string } | null = null;

const P = "acc-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const USER = `${P}user`;
const ORG_KEY = `oc_org_${P}key`;

const AUTH = {
  authorization: `Bearer ${ORG_KEY}`,
  "x-workspace-id": WORKSPACE,
  "content-type": "application/json",
};

/** Session caller: cookie-shaped auth (the mocked getSession) + tenancy
 * headers, no bearer. */
const SESSION_HEADERS = {
  "x-workspace-id": WORKSPACE,
  "content-type": "application/json",
};

/**
 * Record an agent as the one this user created during onboarding — the write
 * `completeOnboarding` performs before the flow navigates into the chat. The
 * greeting is fenced to that agent, so the positive cases seed it; the
 * dashboard-agent test below deliberately does not.
 */
const recordOnboardingAgent = async (agentId: string) => {
  await db.onboardingSurvey.upsert({
    where: { workspaceId: WORKSPACE },
    create: {
      workspaceId: WORKSPACE,
      userId: USER,
      userEmail: `${USER}@example.com`,
      responses: { createdAgentId: agentId },
    },
    update: { responses: { createdAgentId: agentId } },
  });
};

const seedAgent = async (
  suffix: string,
  options: { withKey: boolean; onboarding?: boolean },
) => {
  const agent = await db.agent.create({
    data: {
      workspaceId: WORKSPACE,
      name: `Agent ${suffix}`,
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  if (options.withKey) {
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
  }
  if (options.onboarding !== false) await recordOnboardingAgent(agent.id);
  return agent.id;
};

/** The web's own two calls, in the order the chat makes them — signed in
 * as the person (session auth), exactly like the dashboard. */
const openThread = async (agentId: string) => {
  currentSession = { id: USER, email: `${USER}@example.com` };
  const doorRes = await app.request(
    `/v1/agents/${agentId}/conversations/direct`,
    { method: "PUT", headers: SESSION_HEADERS },
  );
  const conversation = (await doorRes.json()) as { id: string };
  const turnsRes = await app.request(
    `/v1/conversations/${conversation.id}/turns`,
    { headers: SESSION_HEADERS },
  );
  const body = (await turnsRes.json()) as {
    turns: { status: string; source: string; userId: string | null }[];
  };
  return { doorStatus: doorRes.status, conversation, turns: body.turns };
};

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
  await db.onboardingSurvey.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.apiKey.deleteMany({ where: { key: ORG_KEY } });
  await db.organizationMember.deleteMany({
    where: { organizationId: { startsWith: P } },
  });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
  await db.conversation.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.GATEWAY_CA_CERT =
    "-----BEGIN CERTIFICATE-----\npg-proof-fake-ca\n-----END CERTIFICATE-----";

  ({ db } = await import("@onecli/db"));
  const { createApiApp } = await import("../app");
  app = createApiApp({ getSession: async () => currentSession });

  await reset();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Acceptance", organizationId: ORG },
  });
  await db.user.create({
    data: {
      id: USER,
      email: `${USER}@example.com`,
      externalAuthId: USER,
      name: "Tomer Levi",
    },
  });
  // Session auth resolves tenancy through an ACTIVE membership — the same
  // fence the dashboard's own calls cross.
  await db.organizationMember.create({
    data: {
      organizationId: ORG,
      userId: USER,
      userEmail: `${USER}@example.com`,
      role: "owner",
      status: "active",
    },
  });
  await db.apiKey.create({
    data: {
      key: ORG_KEY,
      name: `${P}key`,
      userId: USER,
      userEmail: `${USER}@example.com`,
      organizationId: ORG,
      scope: "organization",
    },
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  currentSession = null;
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.onboardingSurvey.deleteMany({ where: { workspaceId: WORKSPACE } });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

describe.skipIf(!PROOF_URL)(
  "ACCEPTANCE: opening a brand-new thread over the real API",
  () => {
    it("a keyed agent's first thread comes back with a RUNNING greeting — not a finished one", async () => {
      // THE USER'S BUG, at the level they experience it. What matters is not
      // that a turn exists but its STATUS as the web receives it: `queued`
      // (or dispatched/running) means the chat has something live to render
      // and the person watches it answer. A `done` row here is exactly the
      // "he already replied" complaint — the agent's words arriving as
      // history rather than as a performance.
      const agentId = await seedAgent("keyed", { withKey: true });

      const { doorStatus, turns } = await openThread(agentId);

      expect(doorStatus).toBe(200);
      expect(turns).toHaveLength(1);
      expect(turns[0]!.source).toBe("greeting");
      expect(turns[0]!.userId).toBeNull();
      // The whole point: still owed an answer when the web first sees it.
      expect(["queued", "dispatched", "running"]).toContain(turns[0]!.status);
      expect(turns[0]!.status).not.toBe("done");
    });

    it("a keyless agent's first thread comes back EMPTY — no canned words, no failure card", async () => {
      // A brand-new user has no model key by definition, so this is the
      // common onboarding case. The replaced code answered it with a
      // pre-written `done` turn (words the agent never said, in the agent's
      // bubble); failing the turn instead would open the product with a red
      // card. The honest answer is an empty thread the web welcomes into.
      const agentId = await seedAgent("keyless", { withKey: false });

      const { doorStatus, turns } = await openThread(agentId);

      expect(doorStatus).toBe(200);
      expect(turns).toEqual([]);
    });

    it("an agent created LATER, from the dashboard, is never greeted", async () => {
      // THE REPORTED BUG, at the level the user experiences it: they
      // onboarded, then made a second agent from the dashboard, opened its
      // chat, and it messaged them unprompted. The greeting is a first-run
      // moment, not something every new agent does.
      //
      // Deliberately the SAME workspace, user, session and model key as the
      // passing case above — the only difference is which agent onboarding
      // recorded. So this discriminates the fence itself, not the setup.
      const onboardingAgent = await seedAgent("first", { withKey: true });
      const dashboardAgent = await seedAgent("second", {
        withKey: true,
        onboarding: false,
      });
      await recordOnboardingAgent(onboardingAgent);

      // The onboarding agent still gets its greeting...
      const onboarded = await openThread(onboardingAgent);
      expect(onboarded.turns).toHaveLength(1);
      expect(onboarded.turns[0]!.source).toBe("greeting");

      // ...and the one made afterwards opens to silence.
      const { doorStatus, turns } = await openThread(dashboardAgent);

      expect(doorStatus).toBe(200);
      expect(turns).toEqual([]);
    });

    it("re-opening the thread does not add a second greeting", async () => {
      // A refresh, a second tab, or React Query re-running the PUT.
      const agentId = await seedAgent("reopen", { withKey: true });

      await openThread(agentId);
      const second = await openThread(agentId);

      expect(second.turns).toHaveLength(1);
    });

    it("concurrent opens of the same fresh thread still yield exactly one greeting", async () => {
      const agentId = await seedAgent("race", { withKey: true });

      const opens = await Promise.all(
        Array.from({ length: 5 }, () => openThread(agentId)),
      );

      for (const open of opens) expect(open.doorStatus).toBe(200);
      const conversationIds = new Set(opens.map((o) => o.conversation.id));
      expect(conversationIds.size).toBe(1);
      expect(
        await db.turn.count({
          where: { conversationId: [...conversationIds][0]! },
        }),
      ).toBe(1);
    });

    it("the greeting the agent is asked to answer is NOT ranked as background work", async () => {
      // `due-work` ranks AUTOMATION_SOURCES behind user-visible turns for up
      // to WAKE_PRIORITY_AGE_SECONDS. The greeting is the first thing a new
      // user ever sees; it must not queue behind the 9:00 cron cohort.
      const { AUTOMATION_SOURCES } =
        await import("../validations/conversation");
      const agentId = await seedAgent("priority", { withKey: true });

      const { turns } = await openThread(agentId);

      expect(turns[0]!.source).toBe("greeting");
      expect(AUTOMATION_SOURCES as readonly string[]).not.toContain("greeting");
    });

    it("an API-KEY caller is NOT greeted — programs get the door's old contract", async () => {
      // The regression the hosted E2E suite caught in CI: every one of its
      // tests opens the thread with an org API key and then POSTs a turn.
      // With the greeting firing for API callers too, that POST 409'd
      // ("This conversation already has a turn in progress") because the
      // queued greeting occupied the one-active-turn slot — a breaking
      // change to the public API's most natural call sequence. The greeting
      // is a dashboard product moment; a program's open stays silent.
      const agentId = await seedAgent("apikey", { withKey: true });

      currentSession = null;
      const doorRes = await app.request(
        `/v1/agents/${agentId}/conversations/direct`,
        { method: "PUT", headers: AUTH },
      );
      expect(doorRes.status).toBe(200);
      const conversation = (await doorRes.json()) as { id: string };

      expect(
        await db.turn.count({ where: { conversationId: conversation.id } }),
      ).toBe(0);

      // The sequence every integration writes: open, then send. Must not 409.
      const sendRes = await app.request(
        `/v1/conversations/${conversation.id}/turns`,
        {
          method: "POST",
          headers: AUTH,
          body: JSON.stringify({ message: "hello from a program" }),
        },
      );
      expect(sendRes.status).toBe(201);
    });

    it("refuses a FOREIGN workspace's agent — the greeting never reaches another tenant", async () => {
      // The claim insert is raw SQL, so it carries no fence of its own. Its
      // safety is positional: the conversation id can only ever come from
      // `ensureDirectConversation`, which is fenced on workspace + user, and
      // the route resolves the workspace from the CALLER's key. This is the
      // planted negative control for that argument — a cross-tenant agent id
      // must read as not-found and leave no turn anywhere.
      const otherOrg = `${P}org2`;
      const otherWorkspace = `${P}ws2`;
      await db.organization.upsert({
        where: { id: otherOrg },
        create: { id: otherOrg, name: otherOrg, slug: otherOrg },
        update: {},
      });
      await db.workspace.upsert({
        where: { id: otherWorkspace },
        create: {
          id: otherWorkspace,
          name: "Other",
          organizationId: otherOrg,
        },
        update: {},
      });
      const foreign = await db.agent.create({
        data: {
          workspaceId: otherWorkspace,
          name: "Foreign",
          identifier: `${P}foreign`,
          accessToken: `aoc_${P}foreign`,
          kind: "hosted",
          harness: "fake",
        },
        select: { id: true },
      });

      const res = await app.request(
        `/v1/agents/${foreign.id}/conversations/direct`,
        { method: "PUT", headers: AUTH },
      );

      expect(res.status).toBe(404);
      expect(
        await db.turn.count({
          where: { conversation: { agentId: foreign.id } },
        }),
      ).toBe(0);
    });

    it("the greeting is never relayed back to the agent as automated-run context", async () => {
      // buildContinuityBridge relays automation deliveries into the next
      // human turn as "[Context from your automated runs …]". With the
      // greeting classed as an automation, the user's FIRST message would
      // carry the hello back to the model as a report.
      //
      // The greeting is ANSWERED here (a settled turn plus its `text` event)
      // because the bridge only relays deliveries that actually said
      // something — without the event this test would pass vacuously, and
      // did when it was first written.
      const { buildContinuityBridge } = await import("./turn-service");
      const agentId = await seedAgent("bridge", { withKey: true });

      const { conversation, turns } = await openThread(agentId);
      expect(turns[0]!.source).toBe("greeting");

      const greetingTurn = await db.turn.findFirstOrThrow({
        where: { conversationId: conversation.id },
        select: { id: true },
      });
      await db.turn.update({
        where: { id: greetingTurn.id },
        data: { status: "done", finishedAt: new Date() },
      });
      const { lastSeq } = await db.conversation.update({
        where: { id: conversation.id },
        data: { lastSeq: { increment: 1 } },
        select: { lastSeq: true },
      });
      await db.turnEvent.create({
        data: {
          conversationId: conversation.id,
          turnId: greetingTurn.id,
          seq: lastSeq,
          type: "text",
          payload: { type: "text", text: "Hi Tomer. I'm ready to work." },
        },
      });

      const bridge = await buildContinuityBridge(
        conversation.id,
        new Date(Date.now() + 60_000),
      );

      // MUTATION-CHECKED: with `greeting` back in AUTOMATION_SOURCES this
      // returns the "[Context from your automated runs …]" block carrying
      // the agent's own hello.
      expect(bridge).toBeNull();
    });
  },
);
