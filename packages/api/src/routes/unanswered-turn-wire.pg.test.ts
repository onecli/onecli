import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * A turn the model left unanswered, over the REAL wire end to end: the
 * dashboard's own doors in, the runner's authenticated doors for the
 * sandbox's report, and the dashboard's own read back. No service is called
 * directly; every hop is the HTTP surface its real caller uses.
 *
 *   1. the person sends a message: `POST /v1/conversations/:id/messages`
 *      (the session door the chat composer uses);
 *   2. the runner claims it: `POST /v1/runner/work` with its `rnr_` token;
 *   3. the runner reports what the supervisor sent for an unanswered turn:
 *      `turn.events` (started, done) then `turn.finished` failed with
 *      `model_refused` / `model_empty_response`, the runtime's own sentence
 *      as the raw error, and the call's usage: `POST /v1/runner/events`;
 *   4. the chat reads the turn: `GET /v1/conversations/:id/turns`.
 *
 * What is pinned: the person reads the canonical sentence and its code,
 * never the runtime's words; the usage lands; the conversation is free for
 * the next message; an unknown code still keeps the readable sentence (the
 * version-skew posture); and the report is fenced by the authenticated
 * runner (a foreign runner's report changes nothing).
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
let db: Db;
let app: ReturnType<typeof import("../app").createApiApp>;
let getCrypto: typeof import("../providers").getCrypto;
let copy: typeof import("../validations/conversation");

const P = "unanswered-wire-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OWNER = `${P}owner`;
const RUNNER = `${P}runner`;
const RUNNER_TOKEN = `rnr_${P}runner`;
const OTHER_RUNNER = `${P}runner-other`;
const OTHER_RUNNER_TOKEN = `rnr_${P}runner-other`;

/** What the runtime writes for a refusal: operator material only. */
const RUNTIME_REFUSAL =
  "Provider guardrail stopped the response (stop_reason: refusal). The model declined to answer this request.";

let currentSession: { id: string; email: string } | null = null;

const asOwner = () => {
  currentSession = { id: OWNER, email: `${OWNER}@example.com` };
};

const dashboard = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-workspace-id": WORKSPACE,
      ...(init.headers ?? {}),
    },
  });

const runner = (path: string, body: unknown, token = RUNNER_TOKEN) =>
  app.request(`/v1/runner${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

interface WireTurn {
  id: string;
  status: string;
  error: string | null;
  errorCode: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}

const readTurns = async (conversationId: string): Promise<WireTurn[]> => {
  asOwner();
  const res = await dashboard(`/v1/conversations/${conversationId}/turns`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { turns: WireTurn[] }).turns;
};

/** A hosted agent with a key, a live sandbox on RUNNER, and the owner's
 * direct thread with it. */
const seedAgent = async (suffix: string) => {
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
  const secret = await db.secret.create({
    data: {
      scope: "workspace",
      workspaceId: WORKSPACE,
      name: `${P}key-${suffix}`,
      type: "anthropic",
      encryptedValue: await getCrypto().encrypt("sk-ant-test"),
      hostPattern: "api.anthropic.com",
      metadata: { authMode: "api-key" },
    },
    select: { id: true },
  });
  // Granted the way the product does it: a published rule naming the secret
  // with the agent as its identity (what the keyless-turn check reads).
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
  const sandbox = await db.sandbox.create({
    data: {
      agentId: agent.id,
      runnerId: RUNNER,
      status: "running",
      lastActiveAt: new Date(),
      homeAppliedGeneration: 1,
    },
    select: { id: true },
  });
  asOwner();
  const door = await dashboard(`/v1/agents/${agent.id}/conversations/direct`, {
    method: "PUT",
  });
  expect(door.status).toBe(200);
  const { id: conversationId } = (await door.json()) as { id: string };
  return { agentId: agent.id, sandboxId: sandbox.id, conversationId };
};

/** Steps 1 and 2: the person speaks, the runner claims it. */
const sendAndClaim = async (conversationId: string, message: string) => {
  asOwner();
  const sent = await dashboard(`/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
  expect(sent.status).toBe(201);
  const { turn } = (await sent.json()) as { turn: { id: string } };
  currentSession = null;

  const work = await runner("/work", { limit: 5 });
  expect(work.status).toBe(200);
  const items = (
    (await work.json()) as {
      items: { kind: string; turnId?: string }[];
    }
  ).items;
  expect(
    items.some((i) => i.kind === "turn.deliver" && i.turnId === turn.id),
  ).toBe(true);
  return turn.id;
};

/** Step 3: the report the supervisor sends for an unanswered turn. */
const reportUnanswered = async (
  ids: { sandboxId: string; conversationId: string; turnId: string },
  errorCode: string,
  error: string,
  token = RUNNER_TOKEN,
) => {
  const res = await runner(
    "/events",
    {
      events: [
        {
          kind: "turn.events",
          ...ids,
          events: [{ type: "turn.started" }, { type: "turn.done" }],
        },
        {
          kind: "turn.finished",
          ...ids,
          status: "failed",
          error,
          errorCode,
          usage: { inputTokens: 41, outputTokens: 0 },
        },
      ],
    },
    token,
  );
  // The events door acks with no body, foreign or not: a runner learns
  // nothing about what the control plane holds.
  expect(res.status).toBe(204);
};

const reset = async () => {
  await db.sandbox.deleteMany({
    where: { runnerId: { in: [RUNNER, OTHER_RUNNER] } },
  });
  await db.policyRuleTarget.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleIdentity.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleV2.deleteMany({ where: { logicalId: { startsWith: P } } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.secret.deleteMany({ where: { name: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
  await db.workspaceAccess.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.GATEWAY_CA_CERT =
    "-----BEGIN CERTIFICATE-----\nunanswered-wire-ca\n-----END CERTIFICATE-----";

  ({ db } = await import("@onecli/db"));
  ({ getCrypto } = await import("../providers"));
  copy = await import("../validations/conversation");
  const { createApiApp } = await import("../app");
  app = createApiApp({ getSession: async () => currentSession });

  await reset();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Unanswered Wire", organizationId: ORG },
  });
  await db.user.create({
    data: {
      id: OWNER,
      email: `${OWNER}@example.com`,
      externalAuthId: OWNER,
    },
  });
  await db.organizationMember.create({
    data: {
      organizationId: ORG,
      userId: OWNER,
      userEmail: `${OWNER}@example.com`,
      role: "owner",
    },
  });
  await db.workspaceAccess.create({
    data: { workspaceId: WORKSPACE, userId: OWNER, role: "owner" },
  });
  await db.runner.createMany({
    data: [
      { id: RUNNER, name: `${P}runner`, token: RUNNER_TOKEN },
      { id: OTHER_RUNNER, name: `${P}runner-other`, token: OTHER_RUNNER_TOKEN },
    ],
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
});

describe.skipIf(!PROOF_URL)(
  "a turn the model left unanswered, over the real wire",
  () => {
    it.each([
      ["model_refused", RUNTIME_REFUSAL, () => copy.MODEL_REFUSED_MESSAGE],
      [
        "model_empty_response",
        "The model ended its turn without any visible output (stop_reason: stop).",
        () => copy.MODEL_EMPTY_RESPONSE_MESSAGE,
      ],
    ])(
      "%s: the chat reads the canonical sentence, the usage lands, and the next message runs",
      async (errorCode, runtimeWords, expected) => {
        const ids = await seedAgent(errorCode.replace(/_/g, "-"));
        const turnId = await sendAndClaim(ids.conversationId, "hey");
        await reportUnanswered({ ...ids, turnId }, errorCode, runtimeWords);

        const [turn] = (await readTurns(ids.conversationId)).filter(
          (t) => t.id === turnId,
        );
        expect(turn).toMatchObject({
          status: "failed",
          errorCode,
          error: expected(),
          usage: { inputTokens: 41, outputTokens: 0 },
        });
        // The runtime's words are operator material, never the person's.
        expect(turn?.error).not.toContain("stop_reason");

        // The conversation is free: the next message is an ordinary turn,
        // claimable by the runner, not a 409 and not a revival.
        const next = await sendAndClaim(ids.conversationId, "something else");
        expect(next).not.toBe(turnId);
      },
    );

    it("an unknown code keeps the runtime's readable sentence (an older control plane's view)", async () => {
      const ids = await seedAgent("skew");
      const turnId = await sendAndClaim(ids.conversationId, "hey");
      await reportUnanswered(
        { ...ids, turnId },
        "model_refused_v2",
        RUNTIME_REFUSAL,
      );

      const [turn] = (await readTurns(ids.conversationId)).filter(
        (t) => t.id === turnId,
      );
      expect(turn).toMatchObject({
        status: "failed",
        errorCode: null,
        error: RUNTIME_REFUSAL,
      });
    });

    it("a foreign runner's report changes nothing: the fence is the authenticated runner", async () => {
      const ids = await seedAgent("fence");
      const turnId = await sendAndClaim(ids.conversationId, "hey");
      await reportUnanswered(
        { ...ids, turnId },
        "model_refused",
        RUNTIME_REFUSAL,
        OTHER_RUNNER_TOKEN,
      );

      const [turn] = (await readTurns(ids.conversationId)).filter(
        (t) => t.id === turnId,
      );
      expect(turn?.status).toBe("dispatched");
      expect(turn?.errorCode).toBeNull();
    });
  },
);
