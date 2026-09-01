import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";
import { anthropic } from "../llm/anthropic.js";
import {
  AGENT_NEVER_STARTED_MESSAGE,
  AGENT_RESTARTED_MESSAGE,
  AGENT_START_FAILED_MESSAGE,
  AT_CAPACITY_MESSAGE,
  HARNESS_BUSY_MESSAGE,
  IMAGE_UNAVAILABLE_MESSAGE,
  MODEL_PROVIDER_ERROR_MESSAGE,
  TURN_STALLED_MESSAGE,
} from "../validations/conversation.js";

/**
 * The conversation plane on REAL PostgreSQL (step 4; per-user direct threads
 * since step 6).
 *
 * These are the laws a mock cannot show, and each one is load-bearing:
 *
 * - **One active turn per conversation** is a partial unique index, not an
 *   app-layer check — two concurrent posts must not both win.
 * - **`seq` is allocated by a counter column**, so per conversation the order
 *   events are numbered equals the order they commit. A reader that tails from
 *   its highest seq can therefore never skip a row that committed late.
 * - **The turn arms of the dispatch seam** claim under `SKIP LOCKED`, fenced
 *   by runner, with their own limit.
 * - **Cross-workspace fencing** expressed in the WHERE, with a planted foreign
 *   row proving a miss reads as NOT_FOUND rather than as someone else's data.
 * - **Direct threads are per (agent, user) and private to their owner** —
 *   step 6's amendment to §3.18: a partial unique index holds the one-thread
 *   invariant, a CHECK guarantees every direct row knows its owner, and the
 *   `visibleTo` fence keeps a foreign user's read at NOT_FOUND.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Conversations = typeof import("./conversation-service");
type Turns = typeof import("./turn-service");
type DueWork = typeof import("./due-work");
type Sandboxes = typeof import("./sandbox-service");
type EventBusProvider = typeof import("../providers/event-bus");
type Errors = typeof import("./errors");

let db: Db;
let conversations: Conversations;
let turns: Turns;
let dueWork: DueWork;
let sandboxes: Sandboxes;
let eventBus: EventBusProvider;
let ServiceError: Errors["ServiceError"];

const P = "cvp-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
/** A second workspace, so every fence has something real to miss. */
const OTHER_WORKSPACE = `${P}proj-other`;
const RUNNER_A = `${P}runner-a`;
const RUNNER_B = `${P}runner-b`;
/** The user every pre-step-6 flow acts as. */
const USER_A = `${P}user-a`;
/** A second user, so every per-user law has someone real to exclude. */
const USER_B = `${P}user-b`;

/**
 * The origin the web door stamps (`routes/conversations.ts`): posted over the
 * web surface, spoken by user A. The flows that predate per-user threads all
 * post with this; the per-user and origin laws get their own describes below.
 */
const WEB_A = { source: "web", userId: USER_A } as const;

const CAPABILITIES = {
  maxSandboxes: 8,
  backend: "docker",
  homeDurability: "resident",
};

const reset = async () => {
  await db.sandbox.deleteMany({
    where: { runnerId: { in: [RUNNER_A, RUNNER_B] } },
  });
  await db.policyRuleTarget.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleIdentity.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleV2.deleteMany({ where: { logicalId: { startsWith: P } } });
  await db.secret.deleteMany({ where: { name: { startsWith: P } } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
  // After the agents: their conversations (which reference users) cascade away
  // with them, so the user rows are free to go.
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
};

/**
 * Give an agent an injectable LLM key.
 *
 * Every hosted agent in these suites needs one, because §3.2's door 1 fails a
 * turn outright when none is granted — a keyless agent has nothing to answer
 * with. Seeded the way the product does it: a published policy rule naming
 * the secret, with the agent as its identity, which is exactly what
 * `injectableSecretWhere` reads.
 */
const grantLlmKey = async (
  agentId: string,
  suffix: string,
  options: { workspaceId?: string; type?: string; scope?: string } = {},
) => {
  const workspaceId = options.workspaceId ?? WORKSPACE;
  const secret = await db.secret.create({
    data: {
      scope: options.scope ?? "workspace",
      ...(options.scope === "organization"
        ? { organizationId: ORG }
        : { workspaceId }),
      name: `${P}${suffix}`,
      type: options.type ?? "anthropic",
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
      identities: { create: [{ agentId }] },
      targets: { create: [{ kind: "secret", secretId: secret.id }] },
    },
  });
  return secret.id;
};

const seedAgent = async (
  suffix: string,
  options: {
    workspaceId?: string;
    kind?: string;
    /** Skip the LLM grant, to exercise the keyless path deliberately. */
    withoutKey?: boolean;
  } = {},
) => {
  const agent = await db.agent.create({
    data: {
      workspaceId: options.workspaceId ?? WORKSPACE,
      name: `agent ${suffix}`,
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind: options.kind ?? "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  if (!options.withoutKey && (options.kind ?? "hosted") === "hosted")
    await grantLlmKey(agent.id, suffix, { workspaceId: options.workspaceId });
  return agent.id;
};

const seedSandbox = async (
  agentId: string,
  runnerId: string,
  status: string,
) => {
  const sandbox = await db.sandbox.create({
    // homeAppliedGeneration: steady state — boot sync complete, so the
    // due-work sync arm (proven in home-sync.pg.test.ts) stays out of
    // this suite's turn-claim assertions.
    data: {
      agentId,
      runnerId,
      status,
      lastActiveAt: new Date(),
      homeAppliedGeneration: 1,
    },
    select: { id: true },
  });
  return sandbox.id;
};

/** The two authenticated facts a report is fenced by. */
const reporter = (runnerId: string, sandboxId: string) => ({
  runnerId,
  sandboxId,
});

/** An agent with a live sandbox and a conversation — the ready-to-talk state. */
const seedTalkable = async (suffix: string, runnerId = RUNNER_A) => {
  const agentId = await seedAgent(suffix);
  const sandboxId = await seedSandbox(agentId, runnerId, "running");
  const conversation = await conversations.createConversation(WORKSPACE, {
    agentId,
  });
  return { agentId, sandboxId, conversationId: conversation.id };
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  // Pin the edition BEFORE any dynamic import below loads `lib/env`: this
  // suite's paths reach edition slots (door 2's decryptability probe hits
  // getCrypto), and its assertions are onprem semantics. Vitest isolates
  // modules per file but `process.env` LEAKS across files in a reused
  // worker — without the pin the suite inherits whatever edition the
  // previous file left behind (CI's ambient NEXT_PUBLIC_EDITION is cloud).
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  // Door 2 embeds the gateway CA into the spawn payload; provide it here.
  // Without the pin the suite depended on a dev-machine CA pem file (absent
  // on CI) or a sibling file's GATEWAY_CA_CERT env leak — the same
  // green-by-scheduling trap as the edition pin above. The content is never
  // validated by these tests, only carried.
  process.env.GATEWAY_CA_CERT =
    "-----BEGIN CERTIFICATE-----\npg-proof-fake-ca\n-----END CERTIFICATE-----";
  process.env.SANDBOX_IDLE_STOP_SECONDS = "600";
  // Pin the turn clocks: the ageing literals below are written against
  // THESE values, not the production defaults — bumping a default must
  // never silently un-age a test fixture.
  process.env.TURN_CEILING_SECONDS = "1800";
  process.env.TURN_CEILING_WARNING_SECONDS = "300";
  process.env.TURN_STALL_SECONDS = "600";
  // The start payload carries the gateway CA, and without one every compose
  // answers `unavailable` before it reaches the credential rule under test.
  // CI has no ca.pem on disk (a dev machine does), so state it explicitly
  // rather than letting the outcome depend on the host.
  process.env.GATEWAY_CA_CERT =
    "-----BEGIN CERTIFICATE-----\ntest-ca\n-----END CERTIFICATE-----";

  ({ db } = await import("@onecli/db"));
  conversations = await import("./conversation-service");
  turns = await import("./turn-service");
  dueWork = await import("./due-work");
  sandboxes = await import("./sandbox-service");
  eventBus = await import("../providers/event-bus");
  ({ ServiceError } = await import("./errors"));

  await reset();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.createMany({
    data: [
      { id: WORKSPACE, name: "Conversation Workspace", organizationId: ORG },
      { id: OTHER_WORKSPACE, name: "Someone Else", organizationId: ORG },
    ],
  });
  // Real user rows: `Turn.userId` and `Conversation.userId` are foreign keys,
  // so the speakers these suites act as must exist.
  await db.user.createMany({
    data: [USER_A, USER_B].map((id) => ({
      id,
      email: `${id}@example.com`,
      externalAuthId: id,
    })),
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await db.sandbox.deleteMany({
    where: { runnerId: { in: [RUNNER_A, RUNNER_B] } },
  });
  // Conversations, turns and events cascade from the agent.
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
  await db.runner.createMany({
    data: [
      {
        id: RUNNER_A,
        name: "runner a",
        token: `rnr_${P}a`,
        capabilities: CAPABILITIES,
      },
      {
        id: RUNNER_B,
        name: "runner b",
        token: `rnr_${P}b`,
        capabilities: CAPABILITIES,
      },
    ],
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

describe.skipIf(!PROOF_URL)("one active turn per conversation", () => {
  it("refuses a second turn while one is in flight", async () => {
    const { conversationId } = await seedTalkable("one-active");
    await turns.createTurn(WORKSPACE, conversationId, "first", WEB_A);

    await expect(
      turns.createTurn(WORKSPACE, conversationId, "second", WEB_A),
    ).rejects.toThrow(ServiceError);
    await expect(
      turns.createTurn(WORKSPACE, conversationId, "second", WEB_A),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("holds under CONCURRENCY — the index, not the check, is the guard", async () => {
    // Two posts racing: an app-layer "is one active?" read would let both
    // through, because neither sees the other's uncommitted row.
    const { conversationId } = await seedTalkable("race");

    const results = await Promise.allSettled([
      turns.createTurn(WORKSPACE, conversationId, "a", WEB_A),
      turns.createTurn(WORKSPACE, conversationId, "b", WEB_A),
      turns.createTurn(WORKSPACE, conversationId, "c", WEB_A),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.turn.count({ where: { conversationId } })).toBe(1);
  });

  it("fences each of the three ACTIVE statuses", async () => {
    const { conversationId } = await seedTalkable("statuses");
    for (const status of ["queued", "dispatched", "running"]) {
      await db.turn.deleteMany({ where: { conversationId } });
      await db.turn.create({
        data: { conversationId, message: "held", status },
      });

      await expect(
        turns.createTurn(WORKSPACE, conversationId, "next", WEB_A),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    }
  });

  it("frees the slot on every TERMINAL status", async () => {
    const { conversationId } = await seedTalkable("terminal");
    for (const status of ["done", "failed", "aborted"]) {
      await db.turn.deleteMany({ where: { conversationId } });
      await db.turn.create({
        data: { conversationId, message: "over", status },
      });

      const next = await turns.createTurn(
        WORKSPACE,
        conversationId,
        "next",
        WEB_A,
      );
      expect(next.status).toBe("queued");
    }
  });

  it("does NOT fence across conversations of the same agent", async () => {
    // The index is per conversation. Two threads with one agent must both be
    // able to be mid-answer — that is the whole point of the model.
    const { agentId, conversationId } = await seedTalkable("multi");
    const other = await conversations.createConversation(WORKSPACE, {
      agentId,
    });

    await turns.createTurn(WORKSPACE, conversationId, "in thread one", WEB_A);
    const second = await turns.createTurn(
      WORKSPACE,
      other.id,
      "in thread two",
      WEB_A,
    );

    expect(second.status).toBe("queued");
  });

  it("keeps unbounded history once turns have finished", async () => {
    const { conversationId, sandboxId } = await seedTalkable("history");
    for (let i = 0; i < 5; i += 1) {
      const turn = await turns.createTurn(
        WORKSPACE,
        conversationId,
        `msg ${i}`,
        WEB_A,
      );
      await turns.finishTurn({
        reporter: reporter(RUNNER_A, sandboxId),
        conversationId,
        turnId: turn.id,
        status: "done",
      });
    }
    expect(await db.turn.count({ where: { conversationId } })).toBe(5);
  });
});

describe.skipIf(!PROOF_URL)("seq allocation", () => {
  it("numbers a batch contiguously from the conversation counter", async () => {
    const { conversationId, sandboxId } = await seedTalkable("seq-basic");
    const turn = await turns.createTurn(WORKSPACE, conversationId, "hi", WEB_A);

    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turn.id,
      [
        { type: "turn.started" },
        { type: "tool.started", callId: "c1", name: "bash" },
        { type: "tool.finished", callId: "c1", name: "bash", output: "ok" },
      ],
    );

    const rows = await db.turnEvent.findMany({
      where: { conversationId },
      orderBy: { seq: "asc" },
      select: { seq: true, type: true },
    });
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("is strictly increasing under CONCURRENT batches on one conversation", async () => {
    const { conversationId, sandboxId } = await seedTalkable("seq-race");
    const turn = await turns.createTurn(WORKSPACE, conversationId, "hi", WEB_A);

    await Promise.all(
      Array.from({ length: 8 }, () =>
        turns.applyTurnEvents(
          reporter(RUNNER_A, sandboxId),
          conversationId,
          turn.id,
          [
            { type: "tool.started", callId: "x", name: "bash" },
            { type: "tool.finished", callId: "x", name: "bash", output: "ok" },
          ],
        ),
      ),
    );

    const rows = await db.turnEvent.findMany({
      where: { conversationId },
      orderBy: { seq: "asc" },
      select: { seq: true },
    });
    // 16 events, no gaps and no collisions: the counter is the allocator, and
    // its row lock serializes the racers.
    expect(rows.map((r) => r.seq)).toEqual(
      Array.from({ length: 16 }, (_, i) => i + 1),
    );
  });

  it("FENCES a foreign sandbox's batch — it is ignored, not written", async () => {
    // The fence is a tenancy boundary, not bookkeeping: a sandbox that does
    // not host this turn must not be able to append to its transcript, and
    // the rejection is silent by design (a throw would strand the rescue
    // events a dying sandbox sends).
    //
    // MUTATION-PROOF: drop the sandbox arm of the fence and this fails.
    const own = await seedTalkable("fence-own");
    const foreign = await seedTalkable("fence-foreign");
    const turn = await turns.createTurn(
      WORKSPACE,
      own.conversationId,
      "hi",
      WEB_A,
    );

    await turns.applyTurnEvents(
      reporter(RUNNER_A, own.sandboxId),
      own.conversationId,
      turn.id,
      [{ type: "turn.started" }],
    );

    // Same runner, WRONG sandbox: the batch is ignored.
    await turns.applyTurnEvents(
      reporter(RUNNER_A, foreign.sandboxId),
      own.conversationId,
      turn.id,
      [{ type: "turn.done" }],
    );

    // Nothing from the rejected batch landed.
    const rows = await db.turnEvent.findMany({
      where: { conversationId: own.conversationId },
      select: { type: true },
    });
    expect(rows.map((r) => r.type)).toEqual(["turn.started"]);
  });

  it("counts EVERY event, including the ones it does not store", async () => {
    // Deltas consume seq numbers even though they leave no row: a live tail
    // sees them, so the numbering must be the same on both paths or a reader
    // reconnecting would think it had missed something.
    const { conversationId, sandboxId } = await seedTalkable("seq-deltas");
    const turn = await turns.createTurn(WORKSPACE, conversationId, "hi", WEB_A);

    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turn.id,
      [
        { type: "turn.started" },
        { type: "text.delta", text: "streamed" },
        { type: "turn.done" },
      ],
    );

    const rows = await db.turnEvent.findMany({
      where: { conversationId },
      orderBy: { seq: "asc" },
      select: { seq: true, type: true },
    });
    expect(rows.map((r) => [r.type, r.seq])).toEqual([
      ["turn.started", 1],
      ["turn.done", 3],
    ]);
    const conversation = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { lastSeq: true },
    });
    expect(conversation?.lastSeq).toBe(3);
  });

  it("keeps conversations INDEPENDENT — each counts from its own 1", async () => {
    const { agentId, conversationId, sandboxId } =
      await seedTalkable("seq-indep");
    const other = await conversations.createConversation(WORKSPACE, {
      agentId,
    });
    const a = await turns.createTurn(WORKSPACE, conversationId, "a", WEB_A);
    const b = await turns.createTurn(WORKSPACE, other.id, "b", WEB_A);

    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      a.id,
      [{ type: "turn.done" }],
    );
    await turns.applyTurnEvents(reporter(RUNNER_A, sandboxId), other.id, b.id, [
      { type: "turn.done" },
    ]);

    const first = await db.turnEvent.findFirst({ where: { conversationId } });
    const second = await db.turnEvent.findFirst({
      where: { conversationId: other.id },
    });
    expect(first?.seq).toBe(1);
    expect(second?.seq).toBe(1);
  });

  it("SURVIVES a NUL byte in model output instead of losing the batch", async () => {
    // PostgreSQL rejects U+0000 in jsonb, so an unsanitized event raises
    // inside the transaction and rolls back everything alongside it — a
    // conversation losing a stretch of transcript because its agent ran `cat`
    // on a binary file. The control plane strips it rather than trusting the
    // runner to have done so.
    const { conversationId, sandboxId } = await seedTalkable("nul-bytes");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "read a file",
      WEB_A,
    );

    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turn.id,
      [
        { type: "turn.started" },
        {
          type: "tool.finished",
          callId: "c1",
          name: "cat",
          output: `head${String.fromCharCode(0)}tail`,
        },
        { type: "turn.done" },
      ],
    );

    const rows = await db.turnEvent.findMany({
      where: { conversationId },
      orderBy: { seq: "asc" },
      select: { type: true, payload: true },
    });
    // Nothing lost: all three durable events landed.
    expect(rows.map((r) => r.type)).toEqual([
      "turn.started",
      "tool.finished",
      "turn.done",
    ]);
    const payload = rows[1]?.payload as { output?: string } | null;
    expect(payload?.output).toBe("headtail");
  });

  it("persists only the BOUNDED event kinds (the delta law)", async () => {
    const { conversationId, sandboxId } = await seedTalkable("delta-law");
    const turn = await turns.createTurn(WORKSPACE, conversationId, "hi", WEB_A);

    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turn.id,
      [
        { type: "turn.started" },
        ...Array.from({ length: 200 }, () => ({
          type: "text.delta" as const,
          text: "x",
        })),
        { type: "thinking.delta", text: "hmm" },
        { type: "turn.done" },
      ],
    );

    const stored = await db.turnEvent.findMany({
      where: { conversationId },
      select: { type: true },
    });
    // 202 events in, 2 rows out.
    expect(stored.map((r) => r.type)).toEqual(["turn.started", "turn.done"]);
  });

  it("a transcript read after a batch returns exactly what was stored", async () => {
    const { conversationId, sandboxId } = await seedTalkable("transcript");
    const turn = await turns.createTurn(WORKSPACE, conversationId, "hi", WEB_A);
    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turn.id,
      [
        { type: "turn.started" },
        { type: "text.delta", text: "invisible" },
        { type: "turn.done" },
      ],
    );

    const page = await turns.readTranscript(WORKSPACE, conversationId, USER_A);
    expect(page.events.map((e) => e.type)).toEqual([
      "turn.started",
      "turn.done",
    ]);
    expect(page.nextSince).toBe(3);
    expect(page.hasMore).toBe(false);
  });

  it("`since` returns only what came after — the reconnect contract", async () => {
    const { conversationId, sandboxId } = await seedTalkable("since");
    const turn = await turns.createTurn(WORKSPACE, conversationId, "hi", WEB_A);
    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turn.id,
      [
        { type: "turn.started" },
        { type: "tool.started", callId: "c1", name: "bash" },
      ],
    );
    const first = await turns.readTranscript(WORKSPACE, conversationId, USER_A);

    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turn.id,
      [{ type: "turn.done" }],
    );
    const resumed = await turns.readTranscript(
      WORKSPACE,
      conversationId,
      USER_A,
      {
        since: first.nextSince,
      },
    );

    // Nothing lost, nothing repeated.
    expect(resumed.events.map((e) => e.type)).toEqual(["turn.done"]);
  });

  it("pages, reporting hasMore rather than truncating in silence", async () => {
    const { conversationId, sandboxId } = await seedTalkable("paging");
    const turn = await turns.createTurn(WORKSPACE, conversationId, "hi", WEB_A);
    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turn.id,
      Array.from({ length: 5 }, (_, i) => ({
        type: "tool.started" as const,
        callId: `c${i}`,
        name: "bash",
      })),
    );

    const page = await turns.readTranscript(WORKSPACE, conversationId, USER_A, {
      limit: 2,
    });
    expect(page.events).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextSince).toBe(2);
  });

  it("REPORTS the fence verdict — a foreign sandbox's batch is not accepted", async () => {
    // The verdict is a SECURITY signal, not bookkeeping. A rejected batch is
    // ignored rather than thrown (a dying sandbox's rescue events must still
    // land), so a caller acting on the same events — the Slack narration in
    // routes/runner.ts — has nothing else to go on. Swallow it and one
    // tenant's sandbox could drive another tenant's channel thread.
    //
    // MUTATION-PROOF: hardcode `return true` in applyTurnEvents and this
    // fails.
    const own = await seedTalkable("verdict-own");
    const foreign = await seedTalkable("verdict-foreign");
    const turn = await turns.createTurn(
      WORKSPACE,
      own.conversationId,
      "hi",
      WEB_A,
    );

    const accepted = await turns.applyTurnEvents(
      reporter(RUNNER_A, own.sandboxId),
      own.conversationId,
      turn.id,
      [{ type: "turn.started" }],
    );
    expect(accepted).toBe(true);

    // Same runner, WRONG sandbox.
    const rejected = await turns.applyTurnEvents(
      reporter(RUNNER_A, foreign.sandboxId),
      own.conversationId,
      turn.id,
      [{ type: "tool.started", callId: "c1", name: "bash" }],
    );
    expect(rejected).toBe(false);

    // And the rejected batch really was ignored.
    const rows = await db.turnEvent.findMany({
      where: { conversationId: own.conversationId },
      select: { type: true },
    });
    expect(rows.map((r) => r.type)).toEqual(["turn.started"]);
  });
});

describe.skipIf(!PROOF_URL)("the turn arms of the dispatch seam", () => {
  it("claims a queued turn whose sandbox is running, and dispatches it", async () => {
    const { agentId, conversationId, sandboxId } =
      await seedTalkable("due-basic");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "do it",
      WEB_A,
    );

    const claimed = await dueWork.claimDueWork(RUNNER_A, 5);

    expect(claimed).toEqual([
      {
        kind: "turn",
        turnId: turn.id,
        conversationId,
        sandboxId,
        // The owning agent rides the claim for the step-8 context builder.
        agentId,
        message: "do it",
        resumeSessionRef: null,
        // The claim-latency clock (step 6): a fresh turn's is its creation.
        waitedSince: expect.any(Date),
      },
    ]);
    const row = await db.turn.findUnique({ where: { id: turn.id } });
    expect(row?.status).toBe("dispatched");
  });

  it("carries the conversation's session ref so the turn RESUMES", async () => {
    const { conversationId } = await seedTalkable("due-resume");
    await db.conversation.update({
      where: { id: conversationId },
      data: { harnessSessionRef: "sess-xyz" },
    });
    await turns.createTurn(WORKSPACE, conversationId, "again", WEB_A);

    const [claimed] = await dueWork.claimDueWork(RUNNER_A, 5);
    expect(claimed).toMatchObject({ resumeSessionRef: "sess-xyz" });
  });

  it("does NOT claim a turn whose sandbox is not running", async () => {
    const agentId = await seedAgent("due-asleep");
    await seedSandbox(agentId, RUNNER_A, "stopped");
    const conversation = await conversations.createConversation(WORKSPACE, {
      agentId,
    });
    await turns.createTurn(WORKSPACE, conversation.id, "wake up", WEB_A);

    const claimed = await dueWork.claimDueWork(RUNNER_A, 5);
    // The sandbox start is claimed; the turn waits for it to report ready.
    expect(claimed.map((c) => c.kind)).toEqual(["start"]);
  });

  it("NEVER claims another runner's turn (planted cross-runner control)", async () => {
    const mine = await seedTalkable("due-mine", RUNNER_A);
    const theirs = await seedTalkable("due-theirs", RUNNER_B);
    await turns.createTurn(WORKSPACE, mine.conversationId, "mine", WEB_A);
    const foreign = await turns.createTurn(
      WORKSPACE,
      theirs.conversationId,
      "theirs",
      WEB_A,
    );

    const claimed = await dueWork.claimDueWork(RUNNER_A, 10);

    expect(
      claimed.filter((c) => c.kind === "turn").map((c) => c.conversationId),
    ).toEqual([mine.conversationId]);
    const untouched = await db.turn.findUnique({ where: { id: foreign.id } });
    expect(untouched?.status).toBe("queued");
  });

  it("hands one turn to exactly one of two concurrent pollers", async () => {
    const { conversationId } = await seedTalkable("due-race");
    await turns.createTurn(WORKSPACE, conversationId, "once", WEB_A);

    const [a, b] = await Promise.all([
      dueWork.claimDueWork(RUNNER_A, 5),
      dueWork.claimDueWork(RUNNER_A, 5),
    ]);

    const turnItems = [...a, ...b].filter((c) => c.kind === "turn");
    expect(turnItems).toHaveLength(1);
  });

  it("respects its OWN limit, separate from the lifecycle budget", async () => {
    // Six talkable conversations, each with a queued turn. The turn budget is
    // 5, and it must not be reduced by the sandbox work also claimed.
    for (let i = 0; i < 6; i += 1) {
      const { conversationId } = await seedTalkable(`due-limit-${i}`);
      await turns.createTurn(WORKSPACE, conversationId, `msg ${i}`, WEB_A);
    }

    const claimed = await dueWork.claimDueWork(RUNNER_A, 1);

    expect(claimed.filter((c) => c.kind === "turn")).toHaveLength(5);
  });

  it("re-dispatches a turn whose runner died holding it", async () => {
    const { conversationId } = await seedTalkable("due-stale");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "lost",
      WEB_A,
    );
    await dueWork.claimDueWork(RUNNER_A, 5);
    // Two minutes: past the dispatch window (90s), which is deliberately much
    // shorter than the sandbox claim window — a turn written into a socket
    // that died must not be silent for five minutes.
    await db.$executeRaw`UPDATE turns SET updated_at = now() - interval '2 minutes' WHERE id = ${turn.id}`;

    const claimed = await dueWork.claimDueWork(RUNNER_A, 5);
    expect(claimed.filter((c) => c.kind === "turn")).toHaveLength(1);
  });

  it("leaves a FRESHLY dispatched turn alone", async () => {
    const { conversationId } = await seedTalkable("due-fresh");
    await turns.createTurn(WORKSPACE, conversationId, "working", WEB_A);
    await dueWork.claimDueWork(RUNNER_A, 5);

    const second = await dueWork.claimDueWork(RUNNER_A, 5);
    expect(second.filter((c) => c.kind === "turn")).toHaveLength(0);
  });
});

describe.skipIf(!PROOF_URL)("abort dispatch", () => {
  it("carries an abort for an in-flight turn to its runner", async () => {
    const { conversationId, sandboxId } = await seedTalkable("abort-live");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "long one",
      WEB_A,
    );
    await dueWork.claimDueWork(RUNNER_A, 5);

    const result = await turns.abortTurn(WORKSPACE, turn.id, USER_A);
    expect(result).toEqual({ aborted: false, delivered: true });

    const claimed = await dueWork.claimDueWork(RUNNER_A, 5);
    expect(claimed).toContainEqual({
      kind: "turn.abort",
      turnId: turn.id,
      conversationId,
      sandboxId,
    });
  });

  it("delivers an abort ONCE — the flag is claimed, not merely read", async () => {
    // Left set, the same abort would come back on every poll; polls return
    // immediately whenever work exists, so that is a busy loop for as long as
    // the turn takes to stop.
    const { conversationId } = await seedTalkable("abort-once");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "long one",
      WEB_A,
    );
    await dueWork.claimDueWork(RUNNER_A, 5);
    await turns.abortTurn(WORKSPACE, turn.id, USER_A);

    const first = await dueWork.claimDueWork(RUNNER_A, 5);
    const second = await dueWork.claimDueWork(RUNNER_A, 5);

    expect(first.filter((c) => c.kind === "turn.abort")).toHaveLength(1);
    expect(second.filter((c) => c.kind === "turn.abort")).toHaveLength(0);
  });

  it("delivers the abort for a SWEEP-failed turn — the orphan gets stopped", async () => {
    // The ceiling/stall sweeps fail the row and set the flag; the claim
    // arm's `failed` leg is what carries the stop to the sandbox that is
    // still working. Once, like every abort — then never again.
    const { conversationId, sandboxId } = await seedTalkable("abort-swept");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "long one",
      WEB_A,
    );
    await dueWork.claimDueWork(RUNNER_A, 5);
    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turn.id,
      [{ type: "turn.started" }],
    );
    await db.$executeRaw`UPDATE turns SET created_at = now() - interval '90 minutes' WHERE id = ${turn.id}`;
    await dueWork.reclaimStaleTurns();

    const first = await dueWork.claimDueWork(RUNNER_A, 5);
    expect(first).toContainEqual({
      kind: "turn.abort",
      turnId: turn.id,
      conversationId,
      sandboxId,
    });
    const second = await dueWork.claimDueWork(RUNNER_A, 5);
    expect(second.filter((c) => c.kind === "turn.abort")).toHaveLength(0);
    // The claim cleared the flag; the row stays failed.
    const row = await db.turn.findUnique({ where: { id: turn.id } });
    expect(row?.status).toBe("failed");
    expect(row?.abortRequested).toBe(false);
  });

  it("does NOT re-deliver the turn it just aborted", async () => {
    // Both arms run in one transaction, and SKIP LOCKED does not skip a row
    // this transaction already locked — so an abort that leaves the turn
    // `dispatched` past the stale window is followed, in the same poll, by a
    // re-delivery of the very message the user cancelled.
    const { conversationId } = await seedTalkable("abort-no-redeliver");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "long one",
      WEB_A,
    );
    await dueWork.claimDueWork(RUNNER_A, 5);
    // Age it past the 90s re-delivery window, then ask to stop.
    await db.$executeRaw`UPDATE turns SET updated_at = now() - interval '5 minutes' WHERE id = ${turn.id}`;
    await turns.abortTurn(WORKSPACE, turn.id, USER_A);

    const claimed = await dueWork.claimDueWork(RUNNER_A, 5);

    expect(claimed.filter((c) => c.kind === "turn.abort")).toHaveLength(1);
    expect(claimed.filter((c) => c.kind === "turn")).toHaveLength(0);
  });

  it("abandons a QUEUED turn outright — no sandbox ever saw it", async () => {
    const { conversationId } = await seedTalkable("abort-queued");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "never ran",
      WEB_A,
    );

    const result = await turns.abortTurn(WORKSPACE, turn.id, USER_A);

    expect(result).toEqual({ aborted: true, delivered: false });
    const row = await db.turn.findUnique({ where: { id: turn.id } });
    expect(row?.status).toBe("aborted");
    // And the conversation is free again immediately.
    const next = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "try again",
      WEB_A,
    );
    expect(next.status).toBe("queued");
  });

  it("refuses to abort a turn that already finished", async () => {
    const { conversationId, sandboxId } = await seedTalkable("abort-done");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "over",
      WEB_A,
    );
    await turns.finishTurn({
      reporter: reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId: turn.id,
      status: "done",
    });

    await expect(
      turns.abortTurn(WORKSPACE, turn.id, USER_A),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe.skipIf(!PROOF_URL)(
  "a sandbox going down takes its turns with it",
  () => {
    it("REVIVES a dispatched turn the harness never started — invisibly", async () => {
      // The cold-boot law: `dispatched` + `startedAt IS NULL` means zero
      // observable work (promotion to running happens only on turn.started),
      // so the platform re-sends the message itself — same row, back to
      // queued, no terminal status ever written. MUTATION-PROOF: delete the
      // revive arm in applyRunnerEvent and this fails on `failed`.
      const { conversationId, sandboxId } = await seedTalkable("revive");
      const turn = await turns.createTurn(
        WORKSPACE,
        conversationId,
        "mid-flight",
        WEB_A,
      );
      await dueWork.claimDueWork(RUNNER_A, 5); // -> dispatched, never started

      await sandboxes.applyRunnerEvent(RUNNER_A, {
        kind: "sandbox.status",
        sandboxId,
        status: "stopped",
      });

      const row = await db.turn.findUnique({ where: { id: turn.id } });
      expect(row?.status).toBe("queued");
      // The once-fence is stamped, and nothing user-visible happened.
      expect(row?.retriedAt).not.toBeNull();
      expect(row?.error).toBeNull();
      // The dead sandbox is flipped straight to a fresh boot — no 30s
      // failed-start pacing between the death and attempt two.
      expect(
        (await db.sandbox.findUnique({ where: { id: sandboxId } }))?.status,
      ).toBe("unprovisioned");
    });

    it("the SECOND death is terminal, friendly, and coded", async () => {
      // The retriedAt once-fence: one invisible retry, never a loop.
      // MUTATION-PROOF: drop `retriedAt: null` from the revival predicate and
      // this fails on `queued`.
      const { conversationId, sandboxId } = await seedTalkable("revive-once");
      const turn = await turns.createTurn(
        WORKSPACE,
        conversationId,
        "mid-flight",
        WEB_A,
      );
      await dueWork.claimDueWork(RUNNER_A, 5);
      await sandboxes.applyRunnerEvent(RUNNER_A, {
        kind: "sandbox.status",
        sandboxId,
        status: "stopped",
      });

      // Attempt two boots and takes the turn again…
      await dueWork.claimDueWork(RUNNER_A, 5); // start claim -> starting
      await sandboxes.applyRunnerEvent(RUNNER_A, {
        kind: "supervisor.ready",
        sandboxId,
      });
      await dueWork.claimDueWork(RUNNER_A, 5); // -> dispatched again
      // …and dies again, still before any observable work.
      await sandboxes.applyRunnerEvent(RUNNER_A, {
        kind: "sandbox.status",
        sandboxId,
        status: "stopped",
      });

      const row = await db.turn.findUnique({ where: { id: turn.id } });
      expect(row?.status).toBe("failed");
      // The truthful arm: this turn never STARTED, so it gets the
      // start-failed sentence — the same one the finishTurn door's code
      // mapping produces, so both death-report orders converge on one copy.
      expect(row?.error).toBe(AGENT_START_FAILED_MESSAGE);
      expect(row?.errorCode).toBe("agent_start_failed");
      // And the conversation is usable again straight away.
      const next = await turns.createTurn(
        WORKSPACE,
        conversationId,
        "retry",
        WEB_A,
      );
      expect(next.status).toBe("queued");
    });

    it("a RUNNING turn still dies visibly — observable work is never re-run", async () => {
      // The mid-run carve-out: once turn.started landed, side effects may
      // exist and a silent re-send could double them. MUTATION-PROOF: widen
      // the revival predicate to running and this fails on `queued`.
      const { conversationId, sandboxId } = await seedTalkable("running-dies");
      const turn = await turns.createTurn(
        WORKSPACE,
        conversationId,
        "mid-flight",
        WEB_A,
      );
      await dueWork.claimDueWork(RUNNER_A, 5);
      await turns.applyTurnEvents(
        reporter(RUNNER_A, sandboxId),
        conversationId,
        turn.id,
        [{ type: "turn.started" }],
      );

      await sandboxes.applyRunnerEvent(RUNNER_A, {
        kind: "sandbox.status",
        sandboxId,
        status: "stopped",
      });

      const row = await db.turn.findUnique({ where: { id: turn.id } });
      expect(row?.status).toBe("failed");
      expect(row?.error).toBe(AGENT_RESTARTED_MESSAGE);
      expect(row?.errorCode).toBe("agent_restarted");
      expect(row?.retriedAt).toBeNull();
    });

    it("leaves QUEUED turns alone — they were never handed to anything", async () => {
      const { conversationId, sandboxId } = await seedTalkable("queued-kept");
      const turn = await turns.createTurn(
        WORKSPACE,
        conversationId,
        "still mine",
        WEB_A,
      );

      await sandboxes.applyRunnerEvent(RUNNER_A, {
        kind: "sandbox.status",
        sandboxId,
        status: "stopped",
      });

      const row = await db.turn.findUnique({ where: { id: turn.id } });
      expect(row?.status).toBe("queued");
    });

    it("a stale STARTING report cannot drag a running sandbox backwards", async () => {
      // The start batch and supervisor.ready travel by different paths and are
      // not ordered against each other. Applying a late `starting` over
      // `running` strands every turn until the 5-minute stale claim expires.
      const { sandboxId } = await seedTalkable("late-starting");

      await sandboxes.applyRunnerEvent(RUNNER_A, {
        kind: "sandbox.status",
        sandboxId,
        status: "starting",
      });

      expect(
        (await db.sandbox.findUnique({ where: { id: sandboxId } }))?.status,
      ).toBe("running");
    });
  },
);

describe.skipIf(!PROOF_URL)("finishTurn and the cold-death revival", () => {
  it("a failed report for a never-started dispatch revives it; a done or aborted one never does", async () => {
    // The runner's own synthetic failure ("no live channel") and the
    // supervisor's launch-failure turn.result both land here.
    const { conversationId, sandboxId } = await seedTalkable("fin-revive");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "cold",
      WEB_A,
    );
    await dueWork.claimDueWork(RUNNER_A, 5);

    await turns.finishTurn({
      reporter: reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId: turn.id,
      status: "failed",
      error: "harness launch failed: Error: spawn ENOENT",
      errorCode: "agent_start_failed",
    });

    let row = await db.turn.findUnique({ where: { id: turn.id } });
    expect(row?.status).toBe("queued");
    expect(row?.retriedAt).not.toBeNull();
    expect(row?.error).toBeNull();

    // An ABORT is a human decision — the failed-only gate must not re-run it.
    // (The sandbox here still reads running, so the turn re-dispatches
    // directly.) MUTATION-PROOF: apply the revival to every status and this
    // fails on `queued`.
    await dueWork.claimDueWork(RUNNER_A, 5);
    await turns.finishTurn({
      reporter: reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId: turn.id,
      status: "aborted",
    });
    row = await db.turn.findUnique({ where: { id: turn.id } });
    expect(row?.status).toBe("aborted");
  });

  it("an UNCODED failure never revives — a live-harness error must surface, once", async () => {
    // The death-code gate: an ordinary pre-stream failure on a healthy
    // harness (a stale resume ref) is deterministic — reviving it would run
    // it twice and delay the real error. The supervisor deliberately sends
    // no errorCode for those, and the revival door must respect that.
    // MUTATION-PROOF: drop the deathReport gate in finishTurn and this
    // fails on `queued`.
    const { conversationId, sandboxId } = await seedTalkable("fin-uncoded");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "ordinary failure",
      WEB_A,
    );
    await dueWork.claimDueWork(RUNNER_A, 5);

    await turns.finishTurn({
      reporter: reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId: turn.id,
      status: "failed",
      error: "Error: unknown session: fake-session-1",
    });

    const row = await db.turn.findUnique({ where: { id: turn.id } });
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("Error: unknown session: fake-session-1");
    expect(row?.retriedAt).toBeNull();
  });

  it("a LATE failed report cannot kill a just-revived queued turn", async () => {
    // The stopped-first order: the supervisor sends `unhealthy` BEFORE the
    // dying turn's own turn.result, so the strand law revives first and the
    // late failed report must find nothing to close. MUTATION-PROOF: widen
    // the failed close back to every ACTIVE status and this fails on
    // `failed` — that narrowing is the linchpin of order-idempotence.
    const { conversationId, sandboxId } = await seedTalkable("fin-late");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "cold",
      WEB_A,
    );
    await dueWork.claimDueWork(RUNNER_A, 5);
    await sandboxes.applyRunnerEvent(RUNNER_A, {
      kind: "sandbox.status",
      sandboxId,
      status: "stopped",
    });

    await turns.finishTurn({
      reporter: reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId: turn.id,
      status: "failed",
      error: "harness connection closed",
      errorCode: "agent_restarted",
    });

    const row = await db.turn.findUnique({ where: { id: turn.id } });
    expect(row?.status).toBe("queued");
    expect(row?.error).toBeNull();
  });

  it("maps a known failure code to the canonical copy; an unknown one stays raw", async () => {
    const { conversationId, sandboxId } = await seedTalkable("fin-copy");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "first",
      WEB_A,
    );
    await dueWork.claimDueWork(RUNNER_A, 5);
    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turn.id,
      [{ type: "turn.started" }],
    );

    await turns.finishTurn({
      reporter: reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId: turn.id,
      status: "failed",
      error: "harness connection closed",
      errorCode: "agent_restarted",
    });

    const coded = await db.turn.findUnique({ where: { id: turn.id } });
    expect(coded?.error).toBe(AGENT_RESTARTED_MESSAGE);
    expect(coded?.errorCode).toBe("agent_restarted");

    // An unknown code (a newer supervisor's vocabulary) degrades to the raw
    // passthrough — never a crash, never a wrong canonical sentence.
    const second = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "second",
      WEB_A,
    );
    await dueWork.claimDueWork(RUNNER_A, 5);
    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      second.id,
      [{ type: "turn.started" }],
    );
    await turns.finishTurn({
      reporter: reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId: second.id,
      status: "failed",
      error: "the model exploded",
      errorCode: "mystery_code",
    });

    const raw = await db.turn.findUnique({ where: { id: second.id } });
    expect(raw?.status).toBe("failed");
    expect(raw?.error).toBe("the model exploded");
    expect(raw?.errorCode).toBeNull();
  });

  it("closes a model-provider refusal with the canonical copy, never the raw blob", async () => {
    // The supervisor classifies the refusal and sends the raw provider text
    // beside the code; the row must carry ONLY the canonical sentence — the
    // raw blob is operator material (the log and the transcript events).
    const { conversationId, sandboxId } = await seedTalkable("fin-provider");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "first",
      WEB_A,
    );
    await dueWork.claimDueWork(RUNNER_A, 5);
    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turn.id,
      [{ type: "turn.started" }],
    );

    const rawBlob =
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit reached"}}';
    await turns.finishTurn({
      reporter: reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId: turn.id,
      status: "failed",
      error: rawBlob,
      errorCode: "model_provider_error",
    });

    const row = await db.turn.findUnique({ where: { id: turn.id } });
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe(MODEL_PROVIDER_ERROR_MESSAGE);
    expect(row?.errorCode).toBe("model_provider_error");
    expect(row?.error).not.toContain("rate_limit_error");
  });

  it("closes a harness_busy failure with the canonical copy, never the vendor wording", async () => {
    // The adapter's busy self-heal exhausted: the wire carries the code plus
    // the raw refusal (the version-skew guard for OLD control planes) — this
    // control plane knows the code, so the row gets the canonical sentence
    // and the raw text stays operator material.
    const { conversationId, sandboxId } = await seedTalkable("fin-busy");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "first",
      WEB_A,
    );
    await dueWork.claimDueWork(RUNNER_A, 5);
    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turn.id,
      [{ type: "turn.started" }],
    );

    await turns.finishTurn({
      reporter: reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId: turn.id,
      status: "failed",
      error: "Already processing a message",
      errorCode: "harness_busy",
    });

    const row = await db.turn.findUnique({ where: { id: turn.id } });
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe(HARNESS_BUSY_MESSAGE);
    expect(row?.errorCode).toBe("harness_busy");
    expect(row?.error).not.toContain("Already processing");
  });
});

describe.skipIf(!PROOF_URL)(
  "start-failure reasons decide the waiting turns",
  () => {
    /** An agent whose sandbox is mid-start with one queued turn waiting. */
    const seedWaiting = async (suffix: string) => {
      const agentId = await seedAgent(suffix);
      const sandboxId = await seedSandbox(agentId, RUNNER_A, "starting");
      const conversation = await conversations.createConversation(WORKSPACE, {
        agentId,
      });
      const turn = await turns.createTurn(
        WORKSPACE,
        conversation.id,
        "waiting",
        WEB_A,
      );
      return { agentId, sandboxId, turnId: turn.id };
    };

    const failedReport = (
      sandboxId: string,
      reasonCode?: string,
    ): Parameters<Sandboxes["applyRunnerEvent"]>[1] => ({
      kind: "sandbox.status",
      sandboxId,
      status: "failed",
      error: "docker POST /containers/create failed: 404",
      ...(reasonCode && { reasonCode }),
    });

    it("image_unavailable parks the queue NOW with the operator copy", async () => {
      // Retrying cannot conjure software onto the host — waiting would only
      // move the lie from the spinner to the ceiling.
      const { sandboxId, turnId } = await seedWaiting("park-image");

      await sandboxes.applyRunnerEvent(
        RUNNER_A,
        failedReport(sandboxId, "image_unavailable"),
      );

      const row = await db.turn.findUnique({ where: { id: turnId } });
      expect(row?.status).toBe("failed");
      expect(row?.error).toBe(IMAGE_UNAVAILABLE_MESSAGE);
      expect(row?.errorCode).toBe("image_unavailable");
    });

    it("at_capacity waits out the patience window before parking", async () => {
      const { sandboxId, turnId } = await seedWaiting("park-capacity");

      // First failure, young turn: the 30s-paced start retry keeps trying and
      // the user sees nothing. MUTATION-PROOF: park unconditionally and this
      // fails on `failed`.
      await sandboxes.applyRunnerEvent(
        RUNNER_A,
        failedReport(sandboxId, "at_capacity"),
      );
      expect(
        (await db.turn.findUnique({ where: { id: turnId } }))?.status,
      ).toBe("queued");

      // Past the patience window the honest answer replaces the wait.
      await db.$executeRaw`UPDATE turns SET created_at = now() - interval '10 minutes' WHERE id = ${turnId}`;
      await sandboxes.applyRunnerEvent(
        RUNNER_A,
        failedReport(sandboxId, "at_capacity"),
      );

      const row = await db.turn.findUnique({ where: { id: turnId } });
      expect(row?.status).toBe("failed");
      expect(row?.error).toBe(AT_CAPACITY_MESSAGE);
      expect(row?.errorCode).toBe("at_capacity");
    });

    it("a fresh revival restarts the patience clock too", async () => {
      // The COALESCE spelling (retried → promoted → created, newest first) is
      // load-bearing: a just-revived turn whose createdAt is ancient must NOT
      // be parked by a same-window capacity failure — attempt two gets its own
      // patience. MUTATION-PROOF: drop the `retriedAt: null` qualifiers from
      // the probe's later OR arms and this fails on `failed`.
      const { sandboxId, turnId } = await seedWaiting("park-revived");
      await db.$executeRaw`UPDATE turns SET created_at = now() - interval '10 minutes', retried_at = now() WHERE id = ${turnId}`;

      await sandboxes.applyRunnerEvent(
        RUNNER_A,
        failedReport(sandboxId, "at_capacity"),
      );
      expect(
        (await db.turn.findUnique({ where: { id: turnId } }))?.status,
      ).toBe("queued");

      // Once the RETRY clock itself ages past the window, the park applies.
      await db.$executeRaw`UPDATE turns SET retried_at = now() - interval '10 minutes' WHERE id = ${turnId}`;
      await sandboxes.applyRunnerEvent(
        RUNNER_A,
        failedReport(sandboxId, "at_capacity"),
      );
      expect(
        (await db.turn.findUnique({ where: { id: turnId } }))?.status,
      ).toBe("failed");
    });

    it("no reasonCode changes nothing — an old runner gets today's behavior", async () => {
      const { sandboxId, turnId } = await seedWaiting("park-none");
      await db.$executeRaw`UPDATE turns SET created_at = now() - interval '10 minutes' WHERE id = ${turnId}`;

      await sandboxes.applyRunnerEvent(RUNNER_A, failedReport(sandboxId));

      expect(
        (await db.turn.findUnique({ where: { id: turnId } }))?.status,
      ).toBe("queued");
    });
  },
);

describe.skipIf(!PROOF_URL)("stale-turn reclaim", () => {
  it("fails a turn whose sandbox stopped reporting, freeing the conversation", async () => {
    // Without this the active-turn index would block the conversation for
    // good: event posting is fire-and-forget, so a dropped `turn.finished` is
    // a real and recoverable outcome, not an impossibility.
    const { conversationId, sandboxId } = await seedTalkable("reclaim");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "hung",
      WEB_A,
    );
    await dueWork.claimDueWork(RUNNER_A, 5);
    // The turn genuinely RAN (turn.started landed) — that is what makes the
    // time-limit copy true for it, as opposed to the never-started arm below.
    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turn.id,
      [{ type: "turn.started" }],
    );
    // Aged by CREATION, which is the clock a re-dispatch cannot postpone.
    await db.$executeRaw`UPDATE turns SET created_at = now() - interval '90 minutes' WHERE id = ${turn.id}`;

    const swept = await dueWork.reclaimStaleTurns();
    expect(swept.length).toBeGreaterThanOrEqual(1);
    expect(swept).toContainEqual(
      expect.objectContaining({
        turnId: turn.id,
        conversationId,
        errorCode: "turn_time_limit",
      }),
    );

    const row = await db.turn.findUnique({ where: { id: turn.id } });
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("reached its time limit");
    expect(row?.errorCode).toBe("turn_time_limit");
    // Failing the row is half the job — the sweep also flags the orphan so
    // the abort claim arm's failed leg actually stops the work.
    expect(row?.abortRequested).toBe(true);
    const next = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "again",
      WEB_A,
    );
    expect(next.status).toBe("queued");
  });

  it("tells the TRUTH for a turn that never started", async () => {
    // A queued turn whose sandbox never came up spent no time running —
    // burying it under "ran longer than the limit" was a lie users acted on.
    // MUTATION-PROOF: collapse the CASE back to one sentence and this fails.
    const { conversationId } = await seedTalkable("reclaim-cold");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "never ran",
      WEB_A,
    );
    await db.$executeRaw`UPDATE turns SET created_at = now() - interval '90 minutes' WHERE id = ${turn.id}`;

    await dueWork.reclaimStaleTurns();

    const row = await db.turn.findUnique({ where: { id: turn.id } });
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe(AGENT_NEVER_STARTED_MESSAGE);
    expect(row?.errorCode).toBe("agent_start_failed");
    // Nothing ever ran, so there is nothing to stop: no abort flag.
    // MUTATION-PROOF for the `(started_at IS NOT NULL)` arm of the flag.
    expect(row?.abortRequested).toBe(false);
  });

  it("a fresh revival restarts the ceiling budget", async () => {
    // Attempt two deserves a full budget, not attempt one's remainder.
    // MUTATION-PROOF: drop `retried_at` from the COALESCE and this fails on
    // `failed`.
    const { conversationId } = await seedTalkable("reclaim-revived");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "revived",
      WEB_A,
    );
    await dueWork.claimDueWork(RUNNER_A, 5);
    await db.$executeRaw`UPDATE turns SET created_at = now() - interval '90 minutes', retried_at = now() WHERE id = ${turn.id}`;

    await dueWork.reclaimStaleTurns();

    expect((await db.turn.findUnique({ where: { id: turn.id } }))?.status).toBe(
      "dispatched",
    );
  });

  it("leaves a turn that is merely slow (a model can think for minutes)", async () => {
    const { conversationId } = await seedTalkable("reclaim-slow");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "thinking",
      WEB_A,
    );
    await dueWork.claimDueWork(RUNNER_A, 5);

    await dueWork.reclaimStaleTurns();

    const row = await db.turn.findUnique({ where: { id: turn.id } });
    expect(row?.status).toBe("dispatched");
  });
});

/** A running, fenced turn — the shape the heartbeat and stall tests start
 * from (shared by the two describes below). */
const seedRunningTurn = async (suffix: string) => {
  const { conversationId, sandboxId } = await seedTalkable(suffix);
  const turn = await turns.createTurn(WORKSPACE, conversationId, "w", WEB_A);
  await dueWork.claimDueWork(RUNNER_A, 5);
  await turns.applyTurnEvents(
    reporter(RUNNER_A, sandboxId),
    conversationId,
    turn.id,
    [{ type: "turn.started" }],
  );
  return { conversationId, sandboxId, turnId: turn.id };
};

describe.skipIf(!PROOF_URL)("turn progress stamping", () => {
  it("stamps the liveness clock and the sandbox idle clock together", async () => {
    const { conversationId, sandboxId, turnId } =
      await seedRunningTurn("progress");
    await db.sandbox.update({
      where: { id: sandboxId },
      data: { lastActiveAt: new Date(Date.now() - 10 * 60_000) },
    });

    await turns.applyTurnProgress(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId,
    );

    const row = await db.turn.findUnique({ where: { id: turnId } });
    expect(row?.lastProgressAt).not.toBeNull();
    const box = await db.sandbox.findUnique({ where: { id: sandboxId } });
    expect(box!.lastActiveAt!.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it("an ORPHAN's heartbeat moves neither clock", async () => {
    // A sweep already failed the turn; the sandbox is still working and
    // still heartbeating. Stamping the sandbox's idle clock here would let
    // an orphan defer its own idle-stop forever. MUTATION-PROOF for the
    // `status = 'running'` guard and the matched-row gate.
    const { conversationId, sandboxId, turnId } =
      await seedRunningTurn("progress-orphan");
    await db.turn.update({
      where: { id: turnId },
      data: { status: "failed", finishedAt: new Date() },
    });
    const before = new Date(Date.now() - 10 * 60_000);
    await db.sandbox.update({
      where: { id: sandboxId },
      data: { lastActiveAt: before },
    });

    await turns.applyTurnProgress(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId,
    );

    const row = await db.turn.findUnique({ where: { id: turnId } });
    expect(row?.lastProgressAt).toBeNull();
    const box = await db.sandbox.findUnique({ where: { id: sandboxId } });
    expect(box!.lastActiveAt!.getTime()).toBe(before.getTime());
  });

  it("a foreign sandbox cannot stamp another agent's turn", async () => {
    // Same law as every reporter write: the fence is the authenticated
    // sandbox, not the payload's ids.
    const { conversationId, turnId } = await seedRunningTurn("progress-mine");
    const foreign = await seedTalkable("progress-foreign");

    await turns.applyTurnProgress(
      reporter(RUNNER_A, foreign.sandboxId),
      conversationId,
      turnId,
    );

    const row = await db.turn.findUnique({ where: { id: turnId } });
    expect(row?.lastProgressAt).toBeNull();
  });
});

describe.skipIf(!PROOF_URL)("the stall arm", () => {
  it("fails a running turn whose heartbeat went silent past the window", async () => {
    const { conversationId, turnId } = await seedRunningTurn("stall-silent");
    // Last heartbeat 11 minutes ago, against the pinned 600s window.
    await db.$executeRaw`UPDATE turns SET last_progress_at = now() - interval '11 minutes' WHERE id = ${turnId}`;

    const swept = await dueWork.failStalledTurns();

    expect(swept).toContainEqual({
      turnId,
      conversationId,
      error: TURN_STALLED_MESSAGE,
      errorCode: "turn_stalled",
    });
    const row = await db.turn.findUnique({ where: { id: turnId } });
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe(TURN_STALLED_MESSAGE);
    expect(row?.errorCode).toBe("turn_stalled");
    // Flagged for the abort claim arm — silence does not mean stopped.
    expect(row?.abortRequested).toBe(true);
    // And the conversation is free again.
    const next = await turns.createTurn(WORKSPACE, conversationId, "n", WEB_A);
    expect(next.status).toBe("queued");
  });

  it("leaves a turn whose heartbeat is fresh", async () => {
    const { conversationId, sandboxId, turnId } =
      await seedRunningTurn("stall-fresh");
    await turns.applyTurnProgress(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId,
    );

    await dueWork.failStalledTurns();

    const row = await db.turn.findUnique({ where: { id: turnId } });
    expect(row?.status).toBe("running");
  });

  it("never touches a turn that has NO heartbeat clock — the skew fence", async () => {
    // An agent image that predates the heartbeat never stamps the clock:
    // its turns stay ceiling-bounded exactly as before, however long they
    // run. Pins the behavior; the explicit `IS NOT NULL` in the arm is
    // stated intent (SQL's null comparison already excludes these rows, so
    // dropping the predicate alone would not change the outcome).
    const { turnId } = await seedRunningTurn("stall-skew");
    await db.$executeRaw`UPDATE turns SET created_at = now() - interval '25 minutes' WHERE id = ${turnId}`;

    await dueWork.failStalledTurns();

    const row = await db.turn.findUnique({ where: { id: turnId } });
    expect(row?.status).toBe("running");
    expect(row?.lastProgressAt).toBeNull();
  });
});

describe.skipIf(!PROOF_URL)("waking a sleeping agent", () => {
  it("flips a stopped sandbox back to unprovisioned when a turn arrives", async () => {
    const agentId = await seedAgent("wake");
    const sandboxId = await seedSandbox(agentId, RUNNER_A, "stopped");
    const conversation = await conversations.createConversation(WORKSPACE, {
      agentId,
    });

    await turns.createTurn(WORKSPACE, conversation.id, "wake up", WEB_A);

    const sandbox = await db.sandbox.findUnique({ where: { id: sandboxId } });
    expect(sandbox?.status).toBe("unprovisioned");
  });

  it("never disturbs a sandbox that is already on its way up", async () => {
    const agentId = await seedAgent("wake-starting");
    const sandboxId = await seedSandbox(agentId, RUNNER_A, "starting");
    const conversation = await conversations.createConversation(WORKSPACE, {
      agentId,
    });

    await turns.createTurn(WORKSPACE, conversation.id, "hello", WEB_A);

    const sandbox = await db.sandbox.findUnique({ where: { id: sandboxId } });
    expect(sandbox?.status).toBe("starting");
  });

  it("starts a STOPPED sandbox that already has a queued turn", async () => {
    // The deadlock this exists to prevent, seen live: a turn is posted while
    // the sandbox still reads `running` (so `createTurn` wakes nothing), and
    // the sandbox stops a moment later — the runner restarted and reconcile
    // found its channel gone. From then on the start arm would not claim the
    // sandbox (not `unprovisioned`) and the turn arm would not claim the turn
    // (its sandbox is not `running`), so the conversation waited for a
    // completely unrelated message to happen along. Measured at ~8 minutes.
    const { conversationId, sandboxId } = await seedTalkable("queued-wake");
    await turns.createTurn(
      WORKSPACE,
      conversationId,
      "posted while running",
      WEB_A,
    );
    // The sandbox stops AFTER the turn was queued.
    await db.sandbox.update({
      where: { id: sandboxId },
      data: { status: "stopped" },
    });

    const claimed = await dueWork.claimDueWork(RUNNER_A, 5);

    expect(claimed.map((c) => c.kind)).toContain("start");
    const row = await db.sandbox.findUnique({ where: { id: sandboxId } });
    expect(row?.status).toBe("starting");
  });

  it("starts a stopped sandbox whose turn is DISPATCHED, not merely queued", async () => {
    // The twin of the case above, and the one that actually bit: a turn handed
    // to a sandbox that then died is `dispatched`. Matching only `queued`
    // fixed the first deadlock and left this one in place — live, it pinned a
    // turn for 386 seconds while the runner reported the same dead container
    // every 15 seconds.
    const { conversationId, sandboxId } = await seedTalkable("dispatched-wake");
    await turns.createTurn(
      WORKSPACE,
      conversationId,
      "handed over, then lost",
      WEB_A,
    );
    await dueWork.claimDueWork(RUNNER_A, 5); // -> dispatched
    await db.sandbox.update({
      where: { id: sandboxId },
      data: { status: "stopped" },
    });

    const claimed = await dueWork.claimDueWork(RUNNER_A, 5);

    expect(claimed.map((c) => c.kind)).toContain("start");
  });

  it("does not LIVELOCK against the runner re-reporting the sandbox stopped", async () => {
    // The runner observes a dead container every reconcile tick and reports
    // `stopped`. If that report can override an in-flight start, the two
    // fight forever: start, knocked back, start, knocked back.
    const { conversationId, sandboxId } = await seedTalkable("livelock");
    await turns.createTurn(WORKSPACE, conversationId, "please run", WEB_A);
    await db.sandbox.update({
      where: { id: sandboxId },
      data: { status: "stopped" },
    });

    // The start arm claims it...
    expect(
      (await dueWork.claimDueWork(RUNNER_A, 5)).map((c) => c.kind),
    ).toContain("start");
    expect(
      (await db.sandbox.findUnique({ where: { id: sandboxId } }))?.status,
    ).toBe("starting");

    // ...and the runner's next stale observation must NOT undo it.
    await sandboxes.applyRunnerEvent(RUNNER_A, {
      kind: "sandbox.status",
      sandboxId,
      status: "stopped",
    });

    expect(
      (await db.sandbox.findUnique({ where: { id: sandboxId } }))?.status,
    ).toBe("starting");
  });

  it("still accepts a stop for a sandbox that was genuinely running", async () => {
    const { sandboxId } = await seedTalkable("real-stop");

    await sandboxes.applyRunnerEvent(RUNNER_A, {
      kind: "sandbox.status",
      sandboxId,
      status: "stopped",
    });

    expect(
      (await db.sandbox.findUnique({ where: { id: sandboxId } }))?.status,
    ).toBe("stopped");
  });

  it("retries a FAILED sandbox with a queued turn, but only after a backoff", async () => {
    const { conversationId, sandboxId } = await seedTalkable("failed-wake");
    await turns.createTurn(WORKSPACE, conversationId, "waiting", WEB_A);
    await db.sandbox.update({
      where: { id: sandboxId },
      data: { status: "failed" },
    });

    // Freshly failed: NOT due yet. Without this the poll returns the instant
    // work exists, so a sandbox that cannot start — the runner at capacity, a
    // pull failure, a dead daemon — is re-claimed as fast as two HTTP round
    // trips allow, for the whole turn ceiling. That is a hot loop that burns
    // a shared runner on behalf of one tenant.
    expect(
      (await dueWork.claimDueWork(RUNNER_A, 5)).map((c) => c.kind),
    ).not.toContain("start");

    await db.$executeRaw`UPDATE sandboxes SET updated_at = now() - interval '2 minutes' WHERE id = ${sandboxId}`;

    expect(
      (await dueWork.claimDueWork(RUNNER_A, 5)).map((c) => c.kind),
    ).toContain("start");
  });

  it("wakes a STOPPED sandbox immediately — parking is not a failure", async () => {
    // The backoff must not apply here: a parked agent has to answer the
    // moment a message arrives, and that is the latency users feel.
    const { conversationId, sandboxId } = await seedTalkable("stopped-now");
    await turns.createTurn(WORKSPACE, conversationId, "wake up", WEB_A);
    await db.sandbox.update({
      where: { id: sandboxId },
      data: { status: "stopped" },
    });

    expect(
      (await dueWork.claimDueWork(RUNNER_A, 5)).map((c) => c.kind),
    ).toContain("start");
  });

  it("leaves a stopped sandbox with NO queued work asleep", async () => {
    // Sleep is the default (§3.9). Waking a parked agent with nothing to do
    // would defeat the entire point of parking it.
    const { conversationId, sandboxId } = await seedTalkable("stay-asleep");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "done deal",
      WEB_A,
    );
    await turns.finishTurn({
      reporter: reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId: turn.id,
      status: "done",
    });
    await db.sandbox.update({
      where: { id: sandboxId },
      data: { status: "stopped" },
    });

    expect(await dueWork.claimDueWork(RUNNER_A, 5)).toEqual([]);
  });

  it("signals the held poll so the turn does not wait out a re-check", async () => {
    const { conversationId } = await seedTalkable("wake-signal");
    const waiting = dueWork.waitForWork(30_000);
    // Give the waiter a tick to park.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(dueWork.pendingWaiterCount()).toBe(1);

    await turns.createTurn(WORKSPACE, conversationId, "now please", WEB_A);

    // `true` = woken by the SIGNAL, not the timeout — the distinction the
    // held poll uses to run its event-driven passes.
    await expect(waiting).resolves.toBe(true);
  });
});

describe.skipIf(!PROOF_URL)(
  "the idle reaper must not eat a live conversation",
  () => {
    it("refuses to park a sandbox with a turn in flight", async () => {
      const { conversationId, sandboxId } = await seedTalkable("idle-busy");
      await turns.createTurn(
        WORKSPACE,
        conversationId,
        "thinking silently",
        WEB_A,
      );
      // Long past the idle window: the timestamp alone says "park me".
      await db.sandbox.update({
        where: { id: sandboxId },
        data: { lastActiveAt: new Date(Date.now() - 60 * 60 * 1000) },
      });

      const claimed = await dueWork.claimDueWork(RUNNER_A, 5);

      expect(claimed.filter((c) => c.kind === "stop")).toHaveLength(0);
    });

    it("parks it once the turn has finished", async () => {
      const { conversationId, sandboxId } = await seedTalkable("idle-free");
      const turn = await turns.createTurn(
        WORKSPACE,
        conversationId,
        "done soon",
        WEB_A,
      );
      await turns.finishTurn({
        reporter: reporter(RUNNER_A, sandboxId),
        conversationId,
        turnId: turn.id,
        status: "done",
      });
      await db.sandbox.update({
        where: { id: sandboxId },
        data: { lastActiveAt: new Date(Date.now() - 60 * 60 * 1000) },
      });

      const claimed = await dueWork.claimDueWork(RUNNER_A, 5);

      expect(claimed.filter((c) => c.kind === "stop")).toHaveLength(1);
    });

    it("keeps the reaper away while events are still arriving", async () => {
      const { conversationId, sandboxId } = await seedTalkable("idle-active");
      const turn = await turns.createTurn(
        WORKSPACE,
        conversationId,
        "streaming",
        WEB_A,
      );
      await db.sandbox.update({
        where: { id: sandboxId },
        data: { lastActiveAt: new Date(Date.now() - 60 * 60 * 1000) },
      });

      await turns.applyTurnEvents(
        reporter(RUNNER_A, sandboxId),
        conversationId,
        turn.id,
        [{ type: "text.delta", text: "still here" }],
      );

      const sandbox = await db.sandbox.findUnique({ where: { id: sandboxId } });
      expect(sandbox?.lastActiveAt?.getTime()).toBeGreaterThan(
        Date.now() - 60_000,
      );
    });
  },
);

describe.skipIf(!PROOF_URL)("the runner fence on turn reporting", () => {
  // A runner NAMES the conversation and turn it reports about, so those ids
  // are input, not trusted state. Without the fence any `rnr_` token could
  // write into another tenant's transcript, publish to their live stream,
  // end their turns, and repoint their harness session at one it controls.

  it("applies events from the runner that hosts the turn", async () => {
    const { conversationId, sandboxId } = await seedTalkable(
      "fence-own",
      RUNNER_A,
    );
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "mine",
      WEB_A,
    );

    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turn.id,
      [{ type: "turn.started" }],
    );

    expect(await db.turnEvent.count({ where: { conversationId } })).toBe(1);
  });

  it("IGNORES events from a runner that does NOT host the turn", async () => {
    const { conversationId, sandboxId } = await seedTalkable(
      "fence-foreign",
      RUNNER_A,
    );
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "not yours",
      WEB_A,
    );

    await turns.applyTurnEvents(
      reporter(RUNNER_B, sandboxId),
      conversationId,
      turn.id,
      [{ type: "error", message: "INJECTED BY THE WRONG RUNNER" }],
    );

    expect(await db.turnEvent.count({ where: { conversationId } })).toBe(0);
    // And the seq counter did not move, so the victim's stream has no hole.
    const conversation = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { lastSeq: true },
    });
    expect(conversation?.lastSeq).toBe(0);
  });

  it("does not let a foreign runner publish to a live subscriber", async () => {
    const { conversationId, sandboxId } = await seedTalkable(
      "fence-publish",
      RUNNER_A,
    );
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "quiet",
      WEB_A,
    );
    const seen: unknown[] = [];
    const { release } = eventBus
      .getEventBus()
      .subscribe(conversationId, (events) => seen.push(...events));

    await turns.applyTurnEvents(
      reporter(RUNNER_B, sandboxId),
      conversationId,
      turn.id,
      [{ type: "error", message: "INJECTED" }],
    );

    release();
    expect(seen).toHaveLength(0);
  });

  it("IGNORES events from ANOTHER SANDBOX on the SAME runner", async () => {
    // The deeper half of the fence. A sandbox runs model-driven code, so it is
    // the least trusted thing in the system — and it names the conversation it
    // reports about. Fencing only by runner would let every sandbox on a
    // runner forge turns for every other conversation there, which in a
    // single-runner install is every tenant on the box.
    const victim = await seedTalkable("fence-victim", RUNNER_A);
    const attacker = await seedTalkable("fence-attacker", RUNNER_A);
    const turn = await turns.createTurn(
      WORKSPACE,
      victim.conversationId,
      "private",
      WEB_A,
    );

    await turns.applyTurnEvents(
      // Same runner, real credentials — but the wrong sandbox.
      reporter(RUNNER_A, attacker.sandboxId),
      victim.conversationId,
      turn.id,
      [{ type: "error", message: "FORGED BY A NEIGHBOUR SANDBOX" }],
    );

    expect(
      await db.turnEvent.count({
        where: { conversationId: victim.conversationId },
      }),
    ).toBe(0);
  });

  it("IGNORES a finish from another sandbox on the same runner", async () => {
    const victim = await seedTalkable("fence-v2", RUNNER_A);
    const attacker = await seedTalkable("fence-a2", RUNNER_A);
    const turn = await turns.createTurn(
      WORKSPACE,
      victim.conversationId,
      "mine",
      WEB_A,
    );

    await turns.finishTurn({
      reporter: reporter(RUNNER_A, attacker.sandboxId),
      conversationId: victim.conversationId,
      turnId: turn.id,
      status: "done",
      sessionRef: "neighbour-controlled-session",
    });

    const row = await db.turn.findUnique({ where: { id: turn.id } });
    expect(row?.status).toBe("queued");
    const conversation = await db.conversation.findUnique({
      where: { id: victim.conversationId },
      select: { harnessSessionRef: true },
    });
    expect(conversation?.harnessSessionRef).toBeNull();
  });

  it("IGNORES a finish from a runner that does not host the turn", async () => {
    const { conversationId, sandboxId } = await seedTalkable(
      "fence-finish",
      RUNNER_A,
    );
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "running",
      WEB_A,
    );

    await turns.finishTurn({
      reporter: reporter(RUNNER_B, sandboxId),
      conversationId,
      turnId: turn.id,
      status: "failed",
      error: "killed by the wrong runner",
    });

    const row = await db.turn.findUnique({ where: { id: turn.id } });
    expect(row?.status).toBe("queued");
    expect(row?.error).toBeNull();
  });

  it("NEVER lets a foreign runner repoint the harness session", async () => {
    // The nastiest arm: harnessSessionRef is what the NEXT turn resumes from,
    // so writing it cross-tenant aims another tenant's conversation at a
    // session the attacker controls.
    const { conversationId, sandboxId } = await seedTalkable(
      "fence-session",
      RUNNER_A,
    );
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "hello",
      WEB_A,
    );

    await turns.finishTurn({
      reporter: reporter(RUNNER_B, sandboxId),
      conversationId,
      turnId: turn.id,
      status: "done",
      sessionRef: "attacker-controlled-session",
    });

    const conversation = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { harnessSessionRef: true },
    });
    expect(conversation?.harnessSessionRef).toBeNull();
  });

  it("records the session ref for the runner that DOES host it", async () => {
    const { conversationId, sandboxId } = await seedTalkable(
      "fence-session-ok",
      RUNNER_A,
    );
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "hello",
      WEB_A,
    );

    await turns.finishTurn({
      reporter: reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId: turn.id,
      status: "done",
      sessionRef: "sess-legit",
    });

    const conversation = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { harnessSessionRef: true },
    });
    expect(conversation?.harnessSessionRef).toBe("sess-legit");
  });

  it("SALVAGES usage and the session ref from a report that lost to a sweep", async () => {
    // The ceiling failed the turn while the sandbox was still working; the
    // real close arrives late and its status write is a fenced no-op. The
    // two things only the report knows — what the turn cost, and where its
    // session lives — must survive anyway: without the ref, the NEXT turn
    // resumes a stranger.
    const { conversationId, sandboxId } = await seedTalkable(
      "salvage-ok",
      RUNNER_A,
    );
    const turn = await turns.createTurn(WORKSPACE, conversationId, "l", WEB_A);
    await dueWork.claimDueWork(RUNNER_A, 5);
    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turn.id,
      [{ type: "turn.started" }],
    );
    await db.$executeRaw`UPDATE turns SET created_at = now() - interval '90 minutes' WHERE id = ${turn.id}`;
    await dueWork.reclaimStaleTurns();

    await turns.finishTurn({
      reporter: reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId: turn.id,
      status: "done",
      usage: { inputTokens: 12, outputTokens: 34 },
      sessionRef: "sess-salvaged",
    });

    const row = await db.turn.findUnique({ where: { id: turn.id } });
    // The sweep's verdict stands — the loser rewrites nothing about the row
    // itself except the usage it alone knows.
    expect(row?.status).toBe("failed");
    expect(row?.errorCode).toBe("turn_time_limit");
    expect(row?.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
    const conversation = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { harnessSessionRef: true },
    });
    expect(conversation?.harnessSessionRef).toBe("sess-salvaged");
  });

  it("the salvage keeps the fence: a foreign sandbox's late report writes NOTHING", async () => {
    const victim = await seedTalkable("salvage-v", RUNNER_A);
    const attacker = await seedTalkable("salvage-a", RUNNER_A);
    const turn = await turns.createTurn(
      WORKSPACE,
      victim.conversationId,
      "l",
      WEB_A,
    );
    await dueWork.claimDueWork(RUNNER_A, 5);
    await turns.applyTurnEvents(
      reporter(RUNNER_A, victim.sandboxId),
      victim.conversationId,
      turn.id,
      [{ type: "turn.started" }],
    );
    await db.$executeRaw`UPDATE turns SET created_at = now() - interval '90 minutes' WHERE id = ${turn.id}`;
    await dueWork.reclaimStaleTurns();

    await turns.finishTurn({
      reporter: reporter(RUNNER_A, attacker.sandboxId),
      conversationId: victim.conversationId,
      turnId: turn.id,
      status: "done",
      usage: { inputTokens: 1, outputTokens: 1 },
      sessionRef: "neighbour-controlled-session",
    });

    const row = await db.turn.findUnique({ where: { id: turn.id } });
    expect(row?.usage).toBeNull();
    const conversation = await db.conversation.findUnique({
      where: { id: victim.conversationId },
      select: { harnessSessionRef: true },
    });
    expect(conversation?.harnessSessionRef).toBeNull();
  });

  it("the salvage never repoints a conversation that already moved on", async () => {
    // A NEWER turn is underway when the dying boot's late report lands: its
    // own close will persist a fresher ref, and the stale one must not win.
    // Usage still salvages — it belongs to the dead turn, not the live one.
    const { conversationId, sandboxId } = await seedTalkable(
      "salvage-moved-on",
      RUNNER_A,
    );
    const turn = await turns.createTurn(WORKSPACE, conversationId, "l", WEB_A);
    await dueWork.claimDueWork(RUNNER_A, 5);
    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turn.id,
      [{ type: "turn.started" }],
    );
    await db.$executeRaw`UPDATE turns SET created_at = now() - interval '90 minutes' WHERE id = ${turn.id}`;
    await dueWork.reclaimStaleTurns();
    // The conversation is free again — the user sends the next message.
    await turns.createTurn(WORKSPACE, conversationId, "next", WEB_A);

    await turns.finishTurn({
      reporter: reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId: turn.id,
      status: "done",
      usage: { inputTokens: 5, outputTokens: 6 },
      sessionRef: "stale-boot-session",
    });

    const row = await db.turn.findUnique({ where: { id: turn.id } });
    expect(row?.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
    const conversation = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { harnessSessionRef: true },
    });
    expect(conversation?.harnessSessionRef).toBeNull();
  });

  it("marks the turn running when the sandbox says it started", async () => {
    const { conversationId, sandboxId } = await seedTalkable(
      "fence-started",
      RUNNER_A,
    );
    await turns.createTurn(WORKSPACE, conversationId, "go", WEB_A);
    const [claimed] = await dueWork.claimDueWork(RUNNER_A, 5);
    const turnId = claimed?.kind === "turn" ? claimed.turnId : "";

    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId,
      [{ type: "turn.started" }],
    );

    const row = await db.turn.findUnique({ where: { id: turnId } });
    expect(row?.status).toBe("running");
    expect(row?.startedAt).not.toBeNull();
  });
});

describe.skipIf(!PROOF_URL)("cross-workspace fencing", () => {
  it("a conversation in ANOTHER workspace reads as NOT_FOUND", async () => {
    const foreignAgent = await seedAgent("foreign", {
      workspaceId: OTHER_WORKSPACE,
    });
    const foreign = await conversations.createConversation(OTHER_WORKSPACE, {
      agentId: foreignAgent,
    });

    await expect(
      conversations.getConversation(WORKSPACE, foreign.id, USER_A),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses to post a turn into another workspace's conversation", async () => {
    const foreignAgent = await seedAgent("foreign-turn", {
      workspaceId: OTHER_WORKSPACE,
    });
    const foreign = await conversations.createConversation(OTHER_WORKSPACE, {
      agentId: foreignAgent,
    });

    await expect(
      turns.createTurn(WORKSPACE, foreign.id, "hello from outside", WEB_A),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // And nothing was written.
    expect(await db.turn.count({ where: { conversationId: foreign.id } })).toBe(
      0,
    );
  });

  it("refuses to read another workspace's transcript", async () => {
    const foreignAgent = await seedAgent("foreign-read", {
      workspaceId: OTHER_WORKSPACE,
    });
    // A real sandbox on a real runner, so the event below actually lands:
    // otherwise the fence would swallow the seed and this would pass because
    // there was nothing to leak rather than because the read was refused.
    const foreignSandbox = await seedSandbox(foreignAgent, RUNNER_B, "running");
    const foreign = await conversations.createConversation(OTHER_WORKSPACE, {
      agentId: foreignAgent,
    });
    const turn = await turns.createTurn(
      OTHER_WORKSPACE,
      foreign.id,
      "private",
      WEB_A,
    );
    await turns.applyTurnEvents(
      reporter(RUNNER_B, foreignSandbox),
      foreign.id,
      turn.id,
      [{ type: "tool.started", callId: "c1", name: "cat /etc/shadow" }],
    );
    expect(
      await db.turnEvent.count({ where: { conversationId: foreign.id } }),
    ).toBe(1);

    await expect(
      turns.readTranscript(WORKSPACE, foreign.id, USER_A),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses to abort another workspace's turn", async () => {
    const foreignAgent = await seedAgent("foreign-abort", {
      workspaceId: OTHER_WORKSPACE,
    });
    const foreign = await conversations.createConversation(OTHER_WORKSPACE, {
      agentId: foreignAgent,
    });
    const turn = await turns.createTurn(
      OTHER_WORKSPACE,
      foreign.id,
      "theirs",
      WEB_A,
    );

    await expect(
      turns.abortTurn(WORKSPACE, turn.id, USER_A),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const row = await db.turn.findUnique({ where: { id: turn.id } });
    expect(row?.status).toBe("queued");
  });

  it("lists only this workspace's conversations", async () => {
    const { conversationId } = await seedTalkable("list-mine");
    const foreignAgent = await seedAgent("list-theirs", {
      workspaceId: OTHER_WORKSPACE,
    });
    await conversations.createConversation(OTHER_WORKSPACE, {
      agentId: foreignAgent,
    });

    const listed = await conversations.listConversations(WORKSPACE, USER_A);
    expect(listed.map((c) => c.id)).toEqual([conversationId]);
  });
});

describe.skipIf(!PROOF_URL)("conversation creation", () => {
  it("refuses a NON-hosted agent — it has no computer to talk to", async () => {
    const byoAgent = await seedAgent("byo", { kind: "byo" });

    await expect(
      conversations.createConversation(WORKSPACE, { agentId: byoAgent }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("refuses an agent in another workspace", async () => {
    const foreignAgent = await seedAgent("create-foreign", {
      workspaceId: OTHER_WORKSPACE,
    });

    await expect(
      conversations.createConversation(WORKSPACE, { agentId: foreignAgent }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("deleting the agent takes its conversations and transcript with it", async () => {
    const { agentId, conversationId, sandboxId } =
      await seedTalkable("cascade");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "bye",
      WEB_A,
    );
    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turn.id,
      [{ type: "turn.done" }],
    );

    await db.agent.delete({ where: { id: agentId } });

    expect(await db.conversation.count({ where: { id: conversationId } })).toBe(
      0,
    );
    expect(await db.turn.count({ where: { id: turn.id } })).toBe(0);
    expect(await db.turnEvent.count({ where: { conversationId } })).toBe(0);
  });
});

/**
 * The §3.18 invariant on real Postgres, per-user since step 6: ONE direct
 * conversation per (agent, user), held by a partial unique index — not by the
 * app remembering to check. The door (`ensureDirectConversation`) is the only
 * writer of `direct` rows, and every surface one USER reaches the agent
 * through (their web thread, their Slack DM) must land on that user's same
 * row, or "identical history on both surfaces" silently forks. Another user
 * gets another row — whose privacy is the fence suite below.
 */
describe.skipIf(!PROOF_URL)("the direct conversation door", () => {
  it("materializes the thread once and returns the same row forever", async () => {
    const agentId = await seedAgent("direct-once");

    const first = await conversations.ensureDirectConversation(
      WORKSPACE,
      agentId,
      USER_A,
    );
    const second = await conversations.ensureDirectConversation(
      WORKSPACE,
      agentId,
      USER_A,
    );

    expect(first.direct).toBe(true);
    expect(first.title).toBeNull();
    // The row names its owner — this is what the privacy fence keys on, and
    // what tells a caller whose thread it was handed.
    expect(first.userId).toBe(USER_A);
    expect(second.id).toBe(first.id);
    expect(
      await db.conversation.count({ where: { agentId, direct: true } }),
    ).toBe(1);
  });

  it("is PER USER: two users get two distinct threads with one agent", async () => {
    // Step 6's pivot. The old law was one direct thread per agent; the new
    // one is per (agent, user) — a direct thread is one person's private
    // exchange, so two people must never be handed the same row.
    const agentId = await seedAgent("direct-two-users");

    const a = await conversations.ensureDirectConversation(
      WORKSPACE,
      agentId,
      USER_A,
    );
    const b = await conversations.ensureDirectConversation(
      WORKSPACE,
      agentId,
      USER_B,
    );

    expect(a.id).not.toBe(b.id);
    expect(a.userId).toBe(USER_A);
    expect(b.userId).toBe(USER_B);
    // Both rows coexist under the partial index — proof the invariant really
    // moved to (agent, user) rather than staying one-per-agent.
    expect(
      await db.conversation.count({ where: { agentId, direct: true } }),
    ).toBe(2);
  });

  it("an existing thread for user A does not satisfy user B's door", async () => {
    // The get-or-create must resolve by (agent, USER), not by agent alone: a
    // door that finds "the agent's direct thread" would hand B the row A has
    // been talking in — a cross-user history leak through the front door.
    const agentId = await seedAgent("direct-not-shared");
    const a = await conversations.ensureDirectConversation(
      WORKSPACE,
      agentId,
      USER_A,
    );

    const b = await conversations.ensureDirectConversation(
      WORKSPACE,
      agentId,
      USER_B,
    );

    expect(b.id).not.toBe(a.id);
    expect(b.userId).toBe(USER_B);
    // And A's thread is untouched beside it.
    const aRow = await db.conversation.findUnique({ where: { id: a.id } });
    expect(aRow?.userId).toBe(USER_A);
  });

  it("concurrent callers all land on one row", async () => {
    const agentId = await seedAgent("direct-race");

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        conversations.ensureDirectConversation(WORKSPACE, agentId, USER_A),
      ),
    );

    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
    expect(
      await db.conversation.count({ where: { agentId, direct: true } }),
    ).toBe(1);
  });

  it("a caller that LOSES the race gets the winner's row, not an error", async () => {
    // The concurrent test above does NOT prove this: those callers serialize,
    // so the first one's row is committed before the others read, and the
    // recovery branch never runs (verified by mutation — removing it leaves
    // that test green). The losing interleaving has to be built.
    //
    // An UNCOMMITTED winner builds it exactly: under READ COMMITTED the door
    // cannot see the open transaction's row, so it takes the create path, and
    // its INSERT parks on `conversations_one_direct_per_agent_user` until
    // that transaction commits — at which point it gets the real P2002 a race
    // loser gets. Per-user since step 6: winner and loser are the SAME user,
    // because only same-(agent, user) callers collide on the index at all.
    const agentId = await seedAgent("direct-loser");
    const started: Array<
      ReturnType<typeof conversations.ensureDirectConversation>
    > = [];
    let winnerId = "";

    await db.$transaction(async (tx) => {
      const winner = await tx.conversation.create({
        data: { agentId, direct: true, userId: USER_A },
        select: { id: true },
      });
      winnerId = winner.id;

      const door = conversations.ensureDirectConversation(
        WORKSPACE,
        agentId,
        USER_A,
      );
      // An early rejection must not surface as an unhandled rejection while
      // this transaction is still open.
      door.catch(() => {});
      started.push(door);

      // Long enough for the door to read, miss, and park on the index.
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    const [door] = started;
    if (!door) throw new Error("the door never started");
    const loser = await door;

    expect(loser.id).toBe(winnerId);
    expect(loser.direct).toBe(true);
    expect(loser.userId).toBe(USER_A);
    expect(
      await db.conversation.count({ where: { agentId, direct: true } }),
    ).toBe(1);
  });

  it("refuses an agent in another workspace — existence is not ownership", async () => {
    const foreignAgent = await seedAgent("direct-foreign", {
      workspaceId: OTHER_WORKSPACE,
    });

    await expect(
      conversations.ensureDirectConversation(WORKSPACE, foreignAgent, USER_A),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a NON-hosted agent, like every conversation door", async () => {
    const byoAgent = await seedAgent("direct-byo", { kind: "byo" });

    await expect(
      conversations.ensureDirectConversation(WORKSPACE, byoAgent, USER_A),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("the index itself refuses a second row per (agent, user) — the DB is the backstop", async () => {
    // Rewritten by step 6: the OLD assertion here was that any second direct
    // row for the agent is refused. That is no longer the law — another
    // user's row is legal (proven above) — so the backstop is now exact:
    // same agent, same user, second row, refused by the database itself.
    const agentId = await seedAgent("direct-index");
    await conversations.ensureDirectConversation(WORKSPACE, agentId, USER_A);

    await expect(
      db.conversation.create({
        data: { agentId, direct: true, userId: USER_A },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("the DATABASE refuses a direct row with no owner — the CHECK closes the NULL gap", async () => {
    // The partial unique index alone cannot hold "a direct thread knows its
    // owner": under NULLS DISTINCT uniqueness, any number of (agent, NULL)
    // rows would slip past it — unfenceable threads no privacy query could
    // attribute. `conversations_direct_requires_user` is the backstop, and it
    // must hold against RAW writes, not just against the door (which cannot
    // even express this state).
    const agentId = await seedAgent("direct-nouser");

    await expect(
      db.conversation.create({ data: { agentId, direct: true } }),
    ).rejects.toThrow(/conversations_direct_requires_user/);
    expect(await db.conversation.count({ where: { agentId } })).toBe(0);
  });

  it("non-direct conversations stay unlimited beside the one thread", async () => {
    const agentId = await seedAgent("direct-beside");
    await conversations.ensureDirectConversation(WORKSPACE, agentId, USER_A);

    // Future Slack channels / crons: their own conversations, no cap.
    await conversations.createConversation(WORKSPACE, { agentId });
    await conversations.createConversation(WORKSPACE, {
      agentId,
      source: "slack",
      externalRef: "C123",
    });

    expect(await db.conversation.count({ where: { agentId } })).toBe(3);
    expect(
      await db.conversation.count({ where: { agentId, direct: true } }),
    ).toBe(1);
  });

  it("a direct thread stays untitled — the agent is the name", async () => {
    const agentId = await seedAgent("direct-untitled");
    const thread = await conversations.ensureDirectConversation(
      WORKSPACE,
      agentId,
      USER_A,
    );

    await turns.createTurn(WORKSPACE, thread.id, "ship the release", WEB_A);

    const row = await db.conversation.findUnique({ where: { id: thread.id } });
    expect(row?.title).toBeNull();
  });
});

/**
 * The direct-thread privacy fence (`visibleTo` in conversation-service, and
 * its inlined twin in `abortTurn`): a direct conversation is readable and
 * writable ONLY by its owner; everything else in the workspace stays shared.
 * A miss reads NOT_FOUND, never "forbidden" — existence is not confirmed.
 *
 * These tests are the MUTATION PROOF for the fence's OR-arms. Delete the
 * `{ direct: false }` arm and the "shared conversations stay shared" halves
 * fail (a non-owner could no longer read any group thread); delete the
 * `{ userId: viewerUserId }` arm and the owner-side halves fail (every user
 * locked out of their own thread); delete the fence entirely and every
 * NOT_FOUND below becomes a cross-user leak.
 */
describe.skipIf(!PROOF_URL)("the direct-thread privacy fence", () => {
  /** User A's private thread with a fresh hosted agent. */
  const seedPrivateThread = async (suffix: string) => {
    const agentId = await seedAgent(suffix);
    const thread = await conversations.ensureDirectConversation(
      WORKSPACE,
      agentId,
      USER_A,
    );
    return { agentId, threadId: thread.id };
  };

  it("getConversation: a foreign user's read is NOT_FOUND", async () => {
    const { threadId } = await seedPrivateThread("fence-user-get");

    await expect(
      conversations.getConversation(WORKSPACE, threadId, USER_B),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The owner still reads it — the `{ userId }` arm at work.
    const own = await conversations.getConversation(
      WORKSPACE,
      threadId,
      USER_A,
    );
    expect(own.id).toBe(threadId);
  });

  it("requireConversation: the internal loader is fenced identically", async () => {
    // Every other door (createTurn, the stream route) authorizes through
    // this loader, so a hole here would be a hole in all of them.
    const { threadId } = await seedPrivateThread("fence-user-require");

    await expect(
      conversations.requireConversation(WORKSPACE, threadId, USER_B),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("readTranscript refuses a foreign user — the history IS the privacy", async () => {
    const { threadId } = await seedPrivateThread("fence-user-read");

    await expect(
      turns.readTranscript(WORKSPACE, threadId, USER_B),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("listTurns refuses a foreign user", async () => {
    const { threadId } = await seedPrivateThread("fence-user-turns");

    await expect(
      turns.listTurns(WORKSPACE, threadId, USER_B),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("createTurn: a foreign user cannot WRITE into the thread either", async () => {
    // The origin's userId doubles as the fence viewer — one identity, so a
    // caller can never post into a direct thread they could not read.
    const { threadId } = await seedPrivateThread("fence-user-post");

    await expect(
      turns.createTurn(WORKSPACE, threadId, "not my thread", {
        source: "web",
        userId: USER_B,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // And nothing landed in A's transcript.
    expect(await db.turn.count({ where: { conversationId: threadId } })).toBe(
      0,
    );
  });

  it("abortTurn: a turn in a foreign thread is not yours to stop", async () => {
    // Aborting is a write into the thread, and the fence rides
    // turn → conversation → owner.
    const { threadId } = await seedPrivateThread("fence-user-abort");
    const turn = await turns.createTurn(
      WORKSPACE,
      threadId,
      "still mine",
      WEB_A,
    );

    await expect(
      turns.abortTurn(WORKSPACE, turn.id, USER_B),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Untouched: the refusal happened before any write.
    const row = await db.turn.findUnique({ where: { id: turn.id } });
    expect(row?.status).toBe("queued");

    // The owner's abort still works — the fence keys on the viewer, not on
    // some property of the turn.
    await expect(turns.abortTurn(WORKSPACE, turn.id, USER_A)).resolves.toEqual({
      aborted: true,
      delivered: false,
    });
  });

  it("the list EXCLUDES a foreign direct thread and KEEPS shared ones", async () => {
    const { agentId, threadId } = await seedPrivateThread("fence-user-list");
    const group = await conversations.createConversation(WORKSPACE, {
      agentId,
    });

    const bIds = (await conversations.listConversations(WORKSPACE, USER_B)).map(
      (c) => c.id,
    );
    // The group conversation is workspace-shared — the `{ direct: false }` arm.
    expect(bIds).toContain(group.id);
    // A's private thread is not B's to see.
    expect(bIds).not.toContain(threadId);

    // And the owner keeps BOTH — the `{ userId }` arm; losing it would hide
    // every user's own thread from their own list.
    const aIds = (await conversations.listConversations(WORKSPACE, USER_A)).map(
      (c) => c.id,
    );
    expect(aIds).toContain(threadId);
    expect(aIds).toContain(group.id);
  });
});

/**
 * The provider-thread door (`ensureSourcedConversation`): the group sibling
 * of the direct door, used by the channel ingestion paths (step 6). One
 * provider thread — one (agent, source, externalRef) — maps to exactly one
 * conversation, or two concurrent events on one Slack thread would each mint
 * a conversation AND a harness session, splitting the thread's context in
 * two. That is exactly the bleed `source`/`externalRef` exist to prevent.
 */
describe.skipIf(!PROOF_URL)("the sourced conversation door", () => {
  it("get-or-creates by (agent, source, externalRef)", async () => {
    const agentId = await seedAgent("sourced-once");

    const first = await conversations.ensureSourcedConversation(
      WORKSPACE,
      agentId,
      {
        source: "slack",
        externalRef: "C42:1723.001",
        title: "deploy thread",
      },
    );
    const second = await conversations.ensureSourcedConversation(
      WORKSPACE,
      agentId,
      {
        source: "slack",
        externalRef: "C42:1723.001",
      },
    );

    expect(first.direct).toBe(false);
    expect(first.source).toBe("slack");
    expect(first.externalRef).toBe("C42:1723.001");
    expect(first.title).toBe("deploy thread");
    expect(second.id).toBe(first.id);
    expect(await db.conversation.count({ where: { agentId } })).toBe(1);
  });

  it("a different provider thread gets its own conversation", async () => {
    // The pair is what keeps sources apart: one channel, two thread roots,
    // two histories.
    const agentId = await seedAgent("sourced-two");

    const one = await conversations.ensureSourcedConversation(
      WORKSPACE,
      agentId,
      {
        source: "slack",
        externalRef: "C42:1.0",
      },
    );
    const two = await conversations.ensureSourcedConversation(
      WORKSPACE,
      agentId,
      {
        source: "slack",
        externalRef: "C42:2.0",
      },
    );

    expect(one.id).not.toBe(two.id);
    expect(await db.conversation.count({ where: { agentId } })).toBe(2);
  });

  it("sets the title on CREATE and never overwrites it later", async () => {
    // The title belongs to whoever minted the row (a Slack subject, a cron's
    // name). A later event's title must not rename the thread out from under
    // its readers — get-or-create means GET wins, on every field.
    const agentId = await seedAgent("sourced-title");

    await conversations.ensureSourcedConversation(WORKSPACE, agentId, {
      source: "slack",
      externalRef: "C7:1.0",
      title: "the original subject",
    });
    const again = await conversations.ensureSourcedConversation(
      WORKSPACE,
      agentId,
      {
        source: "slack",
        externalRef: "C7:1.0",
        title: "a rename attempt",
      },
    );

    expect(again.title).toBe("the original subject");
    const row = await db.conversation.findFirst({ where: { agentId } });
    expect(row?.title).toBe("the original subject");
  });

  it("a caller that LOSES the create race gets the winner's row", async () => {
    // The same interleaving proof as the direct door's, against THIS door's
    // unique — `conversations(agent_id, source, external_ref)`. An
    // uncommitted winner makes the loser's P2002 deterministic: under READ
    // COMMITTED the door misses the open transaction's row, takes the create
    // path, and parks on the index until the commit hands it the conflict —
    // at which point it must re-read and return the winner, not throw.
    const agentId = await seedAgent("sourced-loser");
    const ref = { source: "slack", externalRef: "C9:race.0" } as const;
    const started: Array<
      ReturnType<typeof conversations.ensureSourcedConversation>
    > = [];
    let winnerId = "";

    await db.$transaction(async (tx) => {
      const winner = await tx.conversation.create({
        data: { agentId, source: ref.source, externalRef: ref.externalRef },
        select: { id: true },
      });
      winnerId = winner.id;

      const door = conversations.ensureSourcedConversation(
        WORKSPACE,
        agentId,
        ref,
      );
      // An early rejection must not surface as an unhandled rejection while
      // this transaction is still open.
      door.catch(() => {});
      started.push(door);

      // Long enough for the door to read, miss, and park on the index.
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    const [door] = started;
    if (!door) throw new Error("the door never started");
    const loser = await door;

    expect(loser.id).toBe(winnerId);
    expect(await db.conversation.count({ where: { agentId } })).toBe(1);
  });
});

/**
 * Turn origin stamping (step 6): `source` is what channel mirroring keys
 * echo-suppression on and what the web renders an origin chip from; `userId`
 * is the speaker. Both are stamped by the door that created the turn, never
 * chosen by the client — so the select had better return what really landed.
 */
describe.skipIf(!PROOF_URL)("turn origin stamping", () => {
  it("stamps the door's source and speaker, and the select returns them", async () => {
    const { conversationId } = await seedTalkable("origin-slack");

    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "from a channel",
      {
        source: "slack",
        userId: USER_A,
      },
    );

    expect(turn.source).toBe("slack");
    expect(turn.userId).toBe(USER_A);
    // And the ROW carries them — the select reflects storage, not input.
    const row = await db.turn.findUnique({ where: { id: turn.id } });
    expect(row?.source).toBe("slack");
    expect(row?.userId).toBe(USER_A);
  });

  it("the web door's stamp reads back as web", async () => {
    // The route always passes `{ source: "web", userId }` — the route suite
    // pins that; this pins that the stamp survives to the response shape.
    const { conversationId } = await seedTalkable("origin-web");

    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "hello",
      WEB_A,
    );

    expect(turn.source).toBe("web");
    expect(turn.userId).toBe(USER_A);
  });
});

/**
 * A transcript without the answer is not a transcript.
 *
 * The delta law keeps `text.delta` ephemeral — thousands of rows to rebuild
 * one paragraph is not storage worth having. But that left the durable
 * transcript holding the user's questions, the tool calls and the lifecycle
 * markers, and not one word of any reply: a reader who refreshed got back half
 * a conversation. The supervisor now coalesces the deltas it forwarded into a
 * single `text` event, and THIS is where that has to survive.
 */
describe.skipIf(!PROOF_URL)("the answer is durable", () => {
  it("stores the coalesced answer and reads it back in order", async () => {
    const { conversationId, sandboxId } = await seedTalkable("answer-durable");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "what is 2+2?",
      WEB_A,
    );

    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turn.id,
      [
        { type: "turn.started" },
        { type: "tool.started", callId: "c1", name: "calc" },
        { type: "tool.finished", callId: "c1", name: "calc", output: "4" },
        // Ephemeral: streamed to live readers, never stored.
        { type: "text.delta", text: "It is " },
        { type: "text.delta", text: "4." },
        // Durable: the whole answer, once, before the terminal marker.
        { type: "text", text: "It is 4." },
        { type: "turn.done" },
      ],
    );

    const page = await turns.readTranscript(WORKSPACE, conversationId, USER_A);
    const kinds = page.events.map((e) => e.type);

    // The deltas did NOT become rows — the delta law still holds.
    expect(kinds.filter((k) => k === "text.delta")).toEqual([]);
    // The answer did, exactly once, and BEFORE the turn's terminal marker.
    expect(kinds.filter((k) => k === "text")).toHaveLength(1);
    expect(kinds.indexOf("text")).toBeLessThan(kinds.indexOf("turn.done"));

    const answer = page.events.find((e) => e.type === "text");
    expect((answer?.payload as { text?: string })?.text).toBe("It is 4.");
  });

  it("a conversation reloaded from the transcript still has its replies", async () => {
    // The actual user-visible bug: refresh the page, lose the agent.
    const { conversationId, sandboxId } = await seedTalkable("answer-reload");
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "hello",
      WEB_A,
    );
    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      turn.id,
      [{ type: "text", text: "Hi — how can I help?" }, { type: "turn.done" }],
    );

    const replies = (
      await turns.readTranscript(WORKSPACE, conversationId, USER_A)
    ).events
      .filter((e) => e.type === "text")
      .map((e) => (e.payload as { text?: string }).text);

    expect(replies).toEqual(["Hi — how can I help?"]);
  });
});

/** A conversation is named after the message that opened it. */
describe.skipIf(!PROOF_URL)("conversation titles", () => {
  it("takes its title from the first message, and never renames itself", async () => {
    const { conversationId } = await seedTalkable("title-first");

    await turns.createTurn(
      WORKSPACE,
      conversationId,
      "  ship   the\n release ",
      WEB_A,
    );
    const first = await db.conversation.findUnique({
      where: { id: conversationId },
    });
    // Whitespace collapsed so a pasted block becomes one scannable row.
    expect(first?.title).toBe("ship the release");

    // Finish the turn so the conversation accepts another.
    await db.turn.updateMany({
      where: { conversationId },
      data: { status: "done" },
    });
    await turns.createTurn(
      WORKSPACE,
      conversationId,
      "and now roll it back",
      WEB_A,
    );
    const second = await db.conversation.findUnique({
      where: { id: conversationId },
    });
    expect(second?.title).toBe("ship the release");
  });

  it("leaves the title NULL when the opener is only whitespace", async () => {
    // `min(1)` counts a space, so this is a legal message. Collapsing it to
    // the empty string and storing THAT would give the reader a blank row
    // where a missing title it can fall back on belongs.
    const { conversationId } = await seedTalkable("title-blank");

    await turns.createTurn(WORKSPACE, conversationId, "   ", WEB_A);

    const row = await db.conversation.findUnique({
      where: { id: conversationId },
    });
    expect(row?.title).toBeNull();
  });

  it("truncates a long opener on a word boundary", async () => {
    const { conversationId } = await seedTalkable("title-long");
    const long =
      "please investigate the intermittent timeout we keep seeing on the payments service during deploys";

    await turns.createTurn(WORKSPACE, conversationId, long, WEB_A);

    const row = await db.conversation.findUnique({
      where: { id: conversationId },
    });
    expect(row?.title?.length).toBeLessThanOrEqual(
      turns.MAX_DERIVED_TITLE_LENGTH + 1,
    );
    expect(row?.title).toMatch(/…$/);
    expect(row?.title).not.toMatch(/\s…$/);
  });
});

describe.skipIf(!PROOF_URL)("the wake's open-promise note", () => {
  const answerTurn = async (
    conversationId: string,
    text: string,
    status = "done",
  ) => {
    const turn = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "do the thing",
      WEB_A,
    );
    await db.turn.update({ where: { id: turn.id }, data: { status } });
    if (text !== "") {
      await db.turnEvent.create({
        data: {
          conversationId,
          turnId: turn.id,
          seq: 1,
          type: "text",
          payload: { text },
        },
      });
    }
    await db.turn.update({
      where: { id: turn.id },
      data: { status, finishedAt: new Date() },
    });
    return turn.id;
  };

  it("carries back the agent's own last reply, bounded", async () => {
    // The whole point: a wake arrives with the platform's instruction and
    // no conversation, so this is the only place an unfinished promise can
    // be read from.
    const { conversationId } = await seedTalkable("promise-basic");
    await answerTurn(
      conversationId,
      "I'll post the rankings once all 5 finish.",
    );

    const note = await turns.buildOpenPromiseNote(conversationId, new Date());

    expect(note).toContain("I'll post the rankings once all 5 finish.");
    expect(note).toContain("deliver it now");
  });

  it("BOUNDS a long reply — a wake prompt is not a transcript", async () => {
    // The note rides the model's context budget beside memory. An agent that
    // answered with a full report would otherwise push the wake's own
    // instructions out of the window it needs to act on.
    //
    // MUTATION-PROOF: drop the slice and this fails.
    const { conversationId } = await seedTalkable("promise-long");
    await answerTurn(conversationId, "x".repeat(5_000));

    const note = await turns.buildOpenPromiseNote(conversationId, new Date());

    expect(note).not.toBeNull();
    expect((note as string).length).toBeLessThan(1_000);
    expect(note).toContain("…");
  });

  it("says nothing when the last turn FAILED — a failure promised nothing", async () => {
    // MUTATION-PROOF: drop `status: "done"` from the lookup and this fails.
    // A failed turn's text is an error, not a commitment, and relaying it
    // would tell the agent it owes work that was never accepted.
    const { conversationId } = await seedTalkable("promise-failed");
    await answerTurn(conversationId, "boom", "failed");

    expect(
      await turns.buildOpenPromiseNote(conversationId, new Date()),
    ).toBeNull();
  });

  it("says nothing when the reply was EMPTY — a bare label is noise", async () => {
    const { conversationId } = await seedTalkable("promise-empty");
    await answerTurn(conversationId, "");

    expect(
      await turns.buildOpenPromiseNote(conversationId, new Date()),
    ).toBeNull();
  });

  it("says nothing on a first-contact wake — no prior reply to owe against", async () => {
    const { conversationId } = await seedTalkable("promise-first");

    expect(
      await turns.buildOpenPromiseNote(conversationId, new Date()),
    ).toBeNull();
  });
});

describe.skipIf(!PROOF_URL)("an agent with no model key (§3.2 door 1)", () => {
  it("answers IN THE THREAD instead of waking anything", async () => {
    const agentId = await seedAgent("nokey", { withoutKey: true });
    const sandboxId = await seedSandbox(agentId, RUNNER_A, "stopped");
    const conversation = await conversations.createConversation(WORKSPACE, {
      agentId,
    });

    const turn = await turns.createTurn(
      WORKSPACE,
      conversation.id,
      "hello?",
      WEB_A,
    );

    // The message is still in the transcript — the user asked something, and
    // a refusal that loses their words is worse than one that explains itself.
    expect(turn.message).toBe("hello?");
    expect(turn.status).toBe("failed");
    expect(turn.errorCode).toBe("no_model_key");
    expect(turn.error).toContain("model key");

    // And nothing was woken. A sandbox started here could only boot and 401.
    const sandbox = await db.sandbox.findUnique({ where: { id: sandboxId } });
    expect(sandbox?.status).toBe("stopped");
  });

  it("leaves the conversation usable — the next send is not a 409", async () => {
    // The turn is TERMINAL, so it releases the one-active partial index. If it
    // stayed active the agent would be bricked by its own explanation.
    const agentId = await seedAgent("nokey-again", { withoutKey: true });
    await seedSandbox(agentId, RUNNER_A, "stopped");
    const conversation = await conversations.createConversation(WORKSPACE, {
      agentId,
    });

    await turns.createTurn(WORKSPACE, conversation.id, "first", WEB_A);
    const second = await turns.createTurn(
      WORKSPACE,
      conversation.id,
      "second",
      WEB_A,
    );
    expect(second.status).toBe("failed");

    // Grant a key and the very next message goes through normally.
    await grantLlmKey(agentId, "nokey-again-key");
    const third = await turns.createTurn(
      WORKSPACE,
      conversation.id,
      "third",
      WEB_A,
    );
    expect(third.status).toBe("queued");
    expect(third.errorCode).toBeNull();
  });

  it("still refuses two concurrent keyless sends", async () => {
    // Created `queued` first and only then failed, precisely so the partial
    // index still arbitrates. Creating it `failed` outright would let both win.
    const agentId = await seedAgent("nokey-race", { withoutKey: true });
    await seedSandbox(agentId, RUNNER_A, "stopped");
    const conversation = await conversations.createConversation(WORKSPACE, {
      agentId,
    });

    const results = await Promise.allSettled([
      turns.createTurn(WORKSPACE, conversation.id, "a", WEB_A),
      turns.createTurn(WORKSPACE, conversation.id, "b", WEB_A),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const rows = await db.turn.count({
      where: { conversationId: conversation.id },
    });
    expect(rows).toBe(1);
  });
});

describe.skipIf(!PROOF_URL)(
  "refusing to start a keyless sandbox (§3.2 door 2)",
  () => {
    it("PARKS the claim with backoff rather than releasing it", async () => {
      // `releaseClaim` puts a sandbox back as `unprovisioned`, which the start
      // arm claims with no backoff at all — so refusing a start and releasing
      // it is an unbounded claim/refuse loop at poll speed. `failed` is the
      // arm that carries the 30s pacing.
      const agentId = await seedAgent("park", { withoutKey: true });
      const sandboxId = await seedSandbox(agentId, RUNNER_A, "starting");
      const conversation = await conversations.createConversation(WORKSPACE, {
        agentId,
      });
      const turn = await db.turn.create({
        data: {
          conversationId: conversation.id,
          message: "run",
          status: "queued",
        },
        select: { id: true },
      });

      await dueWork.parkUnstartableClaim(sandboxId, RUNNER_A, {
        message: "no key",
        code: "no_model_key",
      });

      const sandbox = await db.sandbox.findUnique({ where: { id: sandboxId } });
      expect(sandbox?.status).toBe("failed");

      // And the turn waiting on it is closed out with the real reason, rather
      // than sitting until the ceiling sweeps it with a story about time.
      const row = await db.turn.findUnique({ where: { id: turn.id } });
      expect(row).toMatchObject({
        status: "failed",
        errorCode: "no_model_key",
        error: "no key",
      });
    });

    it("is fenced to the runner that holds the claim", async () => {
      const agentId = await seedAgent("park-fence", { withoutKey: true });
      const sandboxId = await seedSandbox(agentId, RUNNER_A, "starting");

      await dueWork.parkUnstartableClaim(sandboxId, RUNNER_B, {
        message: "no key",
        code: "no_model_key",
      });

      const sandbox = await db.sandbox.findUnique({ where: { id: sandboxId } });
      expect(sandbox?.status).toBe("starting");
    });

    it("composes a payload once a key IS granted", async () => {
      const agentId = await seedAgent("start-ok");
      const sandboxId = await seedSandbox(agentId, RUNNER_A, "starting");

      const decision = await sandboxes.buildSandboxStartPayload(
        sandboxId,
        RUNNER_A,
      );
      expect(decision.ok).toBe(true);
      if (!decision.ok) return;
      // The RESOLVED model, from the granted key's provider — nobody chose it.
      expect(decision.payload.model).toBe(anthropic.defaultModel);
      expect(decision.payload.env.ANTHROPIC_API_KEY).toBe("placeholder");
      // The workspace fence for namespaced backends (sandbox-platform step 3):
      // the cloud manager refuses a create without it, so dropping this field
      // must fail HERE, not as a live 400 on dev.
      expect(decision.payload.workspaceId).toBe(WORKSPACE);
    });

    it("refuses to compose one when the agent has no key", async () => {
      const agentId = await seedAgent("start-nokey", { withoutKey: true });
      const sandboxId = await seedSandbox(agentId, RUNNER_A, "starting");

      const decision = await sandboxes.buildSandboxStartPayload(
        sandboxId,
        RUNNER_A,
      );
      expect(decision).toEqual({ ok: false, reason: "no_llm_credential" });
    });
  },
);
