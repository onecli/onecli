import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * The mid-run follow-up plane on REAL PostgreSQL.
 *
 * Every law here is index- or claim-shaped and invisible in a mock:
 *
 * - **The message door** never 409s a busy conversation — it records a
 *   `joining` follow-up beside the active turn (the partial unique index
 *   untouched), promotes FIFO when the conversation frees up, and refuses
 *   loudly only at the cap.
 * - **The steer claim arm** is at-most-once, runner-fenced, capability-gated,
 *   and FIFO-guarded (an older parked sibling blocks a newer steer — without
 *   the guard the model would see the user's words out of order).
 * - **The settle** rides the terminal report inside the close transaction,
 *   and `joined` is reachable only through a delivery the control plane
 *   itself stamped (`steer_delivered_at`) — a sandbox cannot swallow
 *   messages it was never handed.
 * - **Promotion** (inline at close + the poll backstop) means a message is
 *   never lost, whatever died in between; `promoted_at` restarts the ceiling
 *   clock so a long park never eats the follow-up's own run budget.
 * - **Stop means silence**: aborting the active turn cancels the parked
 *   follow-ups too, at request time and again on the aborted close.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Conversations = typeof import("./conversation-service");
type Turns = typeof import("./turn-service");
type FollowUps = typeof import("./follow-up-service");
type DueWork = typeof import("./due-work");
type Validations = typeof import("../validations/conversation");

let db: Db;
let conversations: Conversations;
let turns: Turns;
let followUps: FollowUps;
let dueWork: DueWork;
let V: Validations;

const P = "fup-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const RUNNER_A = `${P}runner-a`;
/** A runner that never advertised `steerMessages` — the version-skew gate. */
const RUNNER_OLD = `${P}runner-old`;
const USER_A = `${P}user-a`;
const USER_B = `${P}user-b`;

const WEB_A = { source: "web", userId: USER_A } as const;

const STEER_CAPABLE = {
  maxSandboxes: 8,
  backend: "docker",
  homeDurability: "resident",
  steerMessages: true,
};
const PRE_STEER = {
  maxSandboxes: 8,
  backend: "docker",
  homeDurability: "resident",
};

const reset = async () => {
  await db.sandbox.deleteMany({
    where: { runnerId: { in: [RUNNER_A, RUNNER_OLD] } },
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
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
};

/** The way the product grants a key — what §3.2's door 1 reads. */
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
  await grantLlmKey(agent.id, suffix);
  return agent.id;
};

const seedSandbox = async (
  agentId: string,
  runnerId: string,
  status = "running",
) => {
  const sandbox = await db.sandbox.create({
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

const reporter = (runnerId: string, sandboxId: string) => ({
  runnerId,
  sandboxId,
});

/** Agent + running sandbox + conversation — the ready-to-talk state. */
const seedTalkable = async (suffix: string, runnerId = RUNNER_A) => {
  const agentId = await seedAgent(suffix);
  const sandboxId = await seedSandbox(agentId, runnerId);
  const conversation = await conversations.createConversation(WORKSPACE, {
    agentId,
  });
  return { agentId, sandboxId, conversationId: conversation.id };
};

/** Post a turn and claim it to `dispatched` — the live-turn state. */
const seedActiveTurn = async (
  conversationId: string,
  runnerId = RUNNER_A,
  message = "long task",
) => {
  const turn = await turns.createTurn(
    WORKSPACE,
    conversationId,
    message,
    WEB_A,
  );
  const claimed = await dueWork.claimDueWork(runnerId, 10);
  expect(claimed.some((c) => c.kind === "turn" && c.turnId === turn.id)).toBe(
    true,
  );
  return turn;
};

/** Back-date a turn column that only raw SQL can move. */
const backdate = async (
  turnId: string,
  column: "created_at" | "promoted_at",
  date: Date,
) => {
  if (column === "created_at") {
    await db.$executeRaw`UPDATE turns SET created_at = ${date} WHERE id = ${turnId}`;
  } else {
    await db.$executeRaw`UPDATE turns SET promoted_at = ${date} WHERE id = ${turnId}`;
  }
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SANDBOX_IDLE_STOP_SECONDS = "600";
  // Pin the turn clocks: the ageing literals below are written against
  // THESE values, not the production defaults — bumping a default must
  // never silently un-age a test fixture.
  process.env.TURN_CEILING_SECONDS = "1800";
  process.env.TURN_CEILING_WARNING_SECONDS = "300";
  process.env.TURN_STALL_SECONDS = "600";
  process.env.GATEWAY_CA_CERT =
    "-----BEGIN CERTIFICATE-----\ntest-ca\n-----END CERTIFICATE-----";

  ({ db } = await import("@onecli/db"));
  conversations = await import("./conversation-service");
  turns = await import("./turn-service");
  followUps = await import("./follow-up-service");
  dueWork = await import("./due-work");
  V = await import("../validations/conversation");

  await reset();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Follow-Up Workspace", organizationId: ORG },
  });
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
    where: { runnerId: { in: [RUNNER_A, RUNNER_OLD] } },
  });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
  await db.runner.createMany({
    data: [
      {
        id: RUNNER_A,
        name: "steer-capable",
        token: `rnr_${P}a`,
        capabilities: STEER_CAPABLE,
      },
      {
        id: RUNNER_OLD,
        name: "pre-steer",
        token: `rnr_${P}old`,
        capabilities: PRE_STEER,
      },
    ],
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

describe.skipIf(!PROOF_URL)("the message door", () => {
  it("a free conversation gets an ORDINARY turn", async () => {
    const { conversationId } = await seedTalkable("door-free");

    const sent = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "hello",
      WEB_A,
    );

    expect(sent.kind).toBe("turn");
    expect(sent.turn.status).toBe("queued");
    expect(sent.turn.followUpOfTurnId).toBeNull();
  });

  it("a busy conversation gets a JOINING follow-up targeting the active turn — never a 409", async () => {
    const { conversationId } = await seedTalkable("door-busy");
    const active = await seedActiveTurn(conversationId);

    const sent = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "also do this",
      WEB_A,
    );

    expect(sent.kind).toBe("followUp");
    expect(sent.turn.status).toBe("joining");
    expect(sent.turn.followUpOfTurnId).toBe(active.id);
    // The message is stored verbatim — the human's exact words.
    expect(sent.turn.message).toBe("also do this");
  });

  it("promotes the OLDEST parked follow-up FIRST when the conversation is free — FIFO over recency", async () => {
    const { conversationId, sandboxId } = await seedTalkable("door-fifo");
    const target = await seedActiveTurn(conversationId);
    const parked = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "first follow-up",
      WEB_A,
    );
    // The turn closes but its inline promotion "crashed" — simulated by
    // re-parking the row it promoted.
    await turns.finishTurn({
      reporter: reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId: target.id,
      status: "done",
    });
    await db.turn.update({
      where: { id: parked.turn.id },
      data: { status: "joining", promotedAt: null },
    });

    const sent = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "newer message",
      WEB_A,
    );

    // The old message runs; the new one follows up on it.
    const oldRow = await db.turn.findUnique({ where: { id: parked.turn.id } });
    expect(oldRow?.status).toBe("queued");
    expect(sent.kind).toBe("followUp");
    expect(sent.turn.followUpOfTurnId).toBe(parked.turn.id);
  });

  it("refuses at the cap, LOUDLY, with the honest copy", async () => {
    const { conversationId } = await seedTalkable("door-cap");
    await seedActiveTurn(conversationId);
    for (let i = 0; i < V.MAX_JOINING_FOLLOW_UPS; i += 1) {
      await followUps.sendConversationMessage(
        WORKSPACE,
        conversationId,
        `follow-up ${i}`,
        WEB_A,
      );
    }

    await expect(
      followUps.sendConversationMessage(
        WORKSPACE,
        conversationId,
        "one too many",
        WEB_A,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: V.FOLLOW_UP_CAP_MESSAGE,
    });
  });

  it("the privacy fence composes: a foreign user's direct thread reads NOT_FOUND", async () => {
    const { agentId, conversationId } = await seedTalkable("door-fence");
    void conversationId;
    const direct = await conversations.ensureDirectConversation(
      WORKSPACE,
      agentId,
      USER_A,
      "web",
    );

    await expect(
      followUps.sendConversationMessage(WORKSPACE, direct.id, "not yours", {
        source: "web",
        userId: USER_B,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe.skipIf(!PROOF_URL)("the steer claim arm", () => {
  it("claims a follow-up whose target is dispatched, stamping the delivery clock", async () => {
    const { conversationId, sandboxId } = await seedTalkable("steer-claim");
    const target = await seedActiveTurn(conversationId);
    const sent = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "steer me",
      WEB_A,
    );

    const claimed = await dueWork.claimDueWork(RUNNER_A, 10);

    expect(claimed).toEqual([
      {
        kind: "turn.message",
        turnId: sent.turn.id,
        targetTurnId: target.id,
        conversationId,
        sandboxId,
        message: "steer me",
      },
    ]);
    const row = await db.turn.findUnique({ where: { id: sent.turn.id } });
    expect(row?.steerDeliveredAt).not.toBeNull();
    expect(row?.status).toBe("joining");
  });

  it("delivers AT MOST ONCE — a second poll returns nothing", async () => {
    const { conversationId } = await seedTalkable("steer-once");
    await seedActiveTurn(conversationId);
    await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "only once",
      WEB_A,
    );

    const first = await dueWork.claimDueWork(RUNNER_A, 10);
    const second = await dueWork.claimDueWork(RUNNER_A, 10);

    expect(first.filter((c) => c.kind === "turn.message")).toHaveLength(1);
    expect(second.filter((c) => c.kind === "turn.message")).toHaveLength(0);
  });

  it("waits while the target is still QUEUED — the supervisor could not act yet", async () => {
    const { conversationId } = await seedTalkable("steer-queued");
    // A queued turn on a sandbox the claim arm has not dispatched to yet:
    // create it, but DON'T claim.
    await turns.createTurn(WORKSPACE, conversationId, "queued task", WEB_A);
    await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "early follow-up",
      WEB_A,
    );

    // One poll claims the turn (queued → dispatched); the steer arm ran
    // BEFORE the turn arm in that same poll, so the follow-up waits...
    const first = await dueWork.claimDueWork(RUNNER_A, 10);
    expect(first.some((c) => c.kind === "turn")).toBe(true);
    expect(first.some((c) => c.kind === "turn.message")).toBe(false);

    // ...and the NEXT poll delivers it — which also guarantees the deliver
    // frame is already on the socket before the steer ever is.
    const second = await dueWork.claimDueWork(RUNNER_A, 10);
    expect(second.filter((c) => c.kind === "turn.message")).toHaveLength(1);
  });

  it("FIFO guard: an older parked sibling blocks a newer follow-up's steer", async () => {
    const { conversationId, sandboxId } = await seedTalkable("steer-fifo");
    const t1 = await seedActiveTurn(conversationId);
    const older = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "older, never delivered",
      WEB_A,
    );
    // t1 closes; the older follow-up is promoted inline — re-park it to
    // simulate the crash window, leaving a parked older sibling...
    await turns.finishTurn({
      reporter: reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId: t1.id,
      status: "done",
    });
    await db.turn.update({
      where: { id: older.turn.id },
      data: { status: "joining", promotedAt: null },
    });
    // ...while a NEW turn (sent fresh) becomes active with its own follow-up.
    const t2 = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "task 2",
      WEB_A,
    );
    await dueWork.claimDueWork(RUNNER_A, 10);
    const newer = await db.turn.create({
      data: {
        conversationId,
        message: "newer follow-up",
        status: "joining",
        followUpOfTurnId: t2.id,
        source: "web",
        userId: USER_A,
      },
      select: { id: true },
    });

    const claimed = await dueWork.claimDueWork(RUNNER_A, 10);

    // WITHOUT the NOT EXISTS guard this poll would steer the newer message
    // into t2 while the older one still waits — the user's words reordered.
    expect(claimed.filter((c) => c.kind === "turn.message")).toHaveLength(0);
    const newerRow = await db.turn.findUnique({ where: { id: newer.id } });
    expect(newerRow?.steerDeliveredAt).toBeNull();
  });

  it("a DELIVERED older sibling on the SAME live target does not block the next steer", async () => {
    // MUTATION-PROOF for the guard's carve-out: without it, at most ONE
    // message could ever steer into a run — every later mid-run message
    // silently degraded to promotion, which is the feature's core defeated.
    const { conversationId } = await seedTalkable("steer-multi");
    await seedActiveTurn(conversationId);
    await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "first steer",
      WEB_A,
    );
    const first = await dueWork.claimDueWork(RUNNER_A, 10);
    expect(first.filter((c) => c.kind === "turn.message")).toHaveLength(1);

    const second = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "second steer",
      WEB_A,
    );
    const next = await dueWork.claimDueWork(RUNNER_A, 10);

    const steers = next.filter((c) => c.kind === "turn.message");
    expect(steers).toHaveLength(1);
    expect(steers[0]?.turnId).toBe(second.turn.id);
  });

  it("a delivered older sibling toward a DIFFERENT target still blocks", async () => {
    // That sibling can only re-enter as a PROMOTED turn — i.e. AFTER the
    // newer words would have joined the live run. Steering past it would
    // reorder the user's messages.
    const { conversationId } = await seedTalkable("steer-crosstarget");
    const t1 = await seedActiveTurn(conversationId);
    await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "older, delivered toward t1",
      WEB_A,
    );
    const claimed = await dueWork.claimDueWork(RUNNER_A, 10);
    expect(claimed.filter((c) => c.kind === "turn.message")).toHaveLength(1);
    // t1 dies without settling (the crash window): the older follow-up stays
    // joining + delivered, its target terminal.
    await db.turn.update({
      where: { id: t1.id },
      data: { status: "failed", finishedAt: new Date() },
    });
    // A fresh turn runs, with its own follow-up.
    const t2 = await turns.createTurn(WORKSPACE, conversationId, "t2", WEB_A);
    await dueWork.claimDueWork(RUNNER_A, 10);
    const newer = await db.turn.create({
      data: {
        conversationId,
        message: "newer, targeting t2",
        status: "joining",
        followUpOfTurnId: t2.id,
        source: "web",
        userId: USER_A,
      },
      select: { id: true },
    });

    const next = await dueWork.claimDueWork(RUNNER_A, 10);

    expect(next.filter((c) => c.kind === "turn.message")).toHaveLength(0);
    const row = await db.turn.findUnique({ where: { id: newer.id } });
    expect(row?.steerDeliveredAt).toBeNull();
  });

  it("an ATTACHMENT-carrying follow-up NEVER steers — it parks and promotes at close", async () => {
    // The user decision, race-free by construction: the bind commits inside
    // createFollowUp's own transaction, so this carve-out can never observe
    // the row before its attachment. MUTATION-TESTED: delete the
    // `NOT EXISTS (conversation_attachments)` predicate and this steers
    // text-only, orphaning the file on a `joined` row (steers are
    // at-most-once).
    const { conversationId, sandboxId } = await seedTalkable("steer-attach");
    const target = await seedActiveTurn(conversationId);
    // A pending attachment for this conversation + user (bytes inline —
    // the store is not needed; bindAttachmentsToTurn is pure DB).
    const attachment = await db.conversationAttachment.create({
      data: {
        conversationId,
        userId: USER_A,
        source: "web",
        name: "photo.png",
        mimeType: "image/png",
        sizeBytes: 3,
        sha256: "a".repeat(64),
        data: Buffer.from("abc"),
        status: "pending",
      },
      select: { id: true },
    });

    const sent = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "what is this?",
      WEB_A,
      [attachment.id],
    );
    expect(sent.kind).toBe("followUp");
    // The bind rode the create transaction.
    const bound = await db.conversationAttachment.findUniqueOrThrow({
      where: { id: attachment.id },
    });
    expect(bound.status).toBe("bound");
    expect(bound.turnId).toBe(sent.turn.id);

    // The steer arm skips it despite a dispatched target and a capable runner.
    const claimed = await dueWork.claimDueWork(RUNNER_A, 10);
    expect(claimed.filter((c) => c.kind === "turn.message")).toHaveLength(0);
    const row = await db.turn.findUnique({ where: { id: sent.turn.id } });
    expect(row?.steerDeliveredAt).toBeNull();
    expect(row?.status).toBe("joining");

    // Closing the target promotes it to a queued turn of its own.
    await turns.finishTurn({
      reporter: reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId: target.id,
      status: "done",
    });
    const promoted = await db.turn.findUnique({ where: { id: sent.turn.id } });
    expect(promoted?.status).toBe("queued");
    expect(promoted?.promotedAt).not.toBeNull();
  });

  it("never steers through a runner that did not advertise the capability", async () => {
    const { conversationId } = await seedTalkable("steer-skew", RUNNER_OLD);
    await seedActiveTurn(conversationId, RUNNER_OLD);
    await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "old runner",
      WEB_A,
    );

    const claimed = await dueWork.claimDueWork(RUNNER_OLD, 10);

    // The queue-only degrade: the follow-up stays parked (promotion will run
    // it when the turn closes) — an unknown work kind would have poisoned
    // this runner's whole poll batch.
    expect(claimed.filter((c) => c.kind === "turn.message")).toHaveLength(0);
  });

  it("is runner-fenced: another runner's follow-up is never claimed", async () => {
    const { conversationId } = await seedTalkable("steer-fence");
    await seedActiveTurn(conversationId);
    await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "mine",
      WEB_A,
    );

    const claimed = await dueWork.claimDueWork(RUNNER_OLD, 10);
    expect(claimed).toEqual([]);
  });
});

describe.skipIf(!PROOF_URL)("the terminal settle", () => {
  /** Door → claim (stamps delivery) → the state a real steer reaches. */
  const seedDeliveredSteer = async (suffix: string) => {
    const seeded = await seedTalkable(suffix);
    const target = await seedActiveTurn(seeded.conversationId);
    const sent = await followUps.sendConversationMessage(
      WORKSPACE,
      seeded.conversationId,
      "delivered follow-up",
      WEB_A,
    );
    const claimed = await dueWork.claimDueWork(RUNNER_A, 10);
    expect(claimed.some((c) => c.kind === "turn.message")).toBe(true);
    return { ...seeded, target, followUpId: sent.turn.id };
  };

  it("marks a DELIVERED follow-up joined on the winning close", async () => {
    const s = await seedDeliveredSteer("settle-joined");

    await turns.finishTurn({
      reporter: reporter(RUNNER_A, s.sandboxId),
      conversationId: s.conversationId,
      turnId: s.target.id,
      status: "done",
      followUps: [{ turnId: s.followUpId, outcome: "joined" }],
    });

    const row = await db.turn.findUnique({ where: { id: s.followUpId } });
    expect(row?.status).toBe("joined");
    expect(row?.finishedAt).not.toBeNull();
  });

  it("an UNDELIVERED follow-up can never be marked joined — it promotes instead", async () => {
    // MUTATION-PROOF for the `steerDeliveredAt != null` clause: without it a
    // buggy or malicious sandbox could terminalize messages it was never
    // handed, silently swallowing them.
    const { conversationId, sandboxId } = await seedTalkable("settle-undel");
    const target = await seedActiveTurn(conversationId);
    const sent = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "never delivered",
      WEB_A,
    );

    await turns.finishTurn({
      reporter: reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId: target.id,
      status: "done",
      followUps: [{ turnId: sent.turn.id, outcome: "joined" }],
    });

    const row = await db.turn.findUnique({ where: { id: sent.turn.id } });
    expect(row?.status).toBe("queued"); // promoted, NOT joined
    expect(row?.promotedAt).not.toBeNull();
  });

  it("is fenced to the reported turn: an outcome naming a foreign target settles nothing", async () => {
    const s = await seedDeliveredSteer("settle-foreign");
    // A second conversation with its own delivered steer.
    const other = await seedDeliveredSteer("settle-foreign-2");

    // s's close claims OTHER's follow-up as joined.
    await turns.finishTurn({
      reporter: reporter(RUNNER_A, s.sandboxId),
      conversationId: s.conversationId,
      turnId: s.target.id,
      status: "done",
      followUps: [{ turnId: other.followUpId, outcome: "joined" }],
    });

    const row = await db.turn.findUnique({ where: { id: other.followUpId } });
    // Untouched by the foreign close (its own conversation still runs).
    expect(row?.status).toBe("joining");
  });

  it("never resurrects an ABORTED follow-up", async () => {
    const s = await seedDeliveredSteer("settle-aborted");
    await turns.abortTurn(WORKSPACE, s.followUpId, USER_A);

    await turns.finishTurn({
      reporter: reporter(RUNNER_A, s.sandboxId),
      conversationId: s.conversationId,
      turnId: s.target.id,
      status: "done",
      followUps: [{ turnId: s.followUpId, outcome: "joined" }],
    });

    const row = await db.turn.findUnique({ where: { id: s.followUpId } });
    expect(row?.status).toBe("aborted");
  });

  it("a LATE DUPLICATE report settles nothing — only the winning close does", async () => {
    const s = await seedDeliveredSteer("settle-dup");
    // The winning close: no outcomes (missed) → the follow-up promotes.
    await turns.finishTurn({
      reporter: reporter(RUNNER_A, s.sandboxId),
      conversationId: s.conversationId,
      turnId: s.target.id,
      status: "done",
    });
    const promoted = await db.turn.findUnique({ where: { id: s.followUpId } });
    expect(promoted?.status).toBe("queued");

    // The stale-dispatch twin reports later, claiming it joined.
    await turns.finishTurn({
      reporter: reporter(RUNNER_A, s.sandboxId),
      conversationId: s.conversationId,
      turnId: s.target.id,
      status: "done",
      followUps: [{ turnId: s.followUpId, outcome: "joined" }],
    });

    const row = await db.turn.findUnique({ where: { id: s.followUpId } });
    expect(row?.status).toBe("queued"); // the duplicate changed nothing
  });

  it("a report for an ALREADY-TERMINAL turn settles nothing — the close must WIN", async () => {
    // The count gate's own scenario: the ceiling sweep failed the target
    // (say, the answer arrived just past the limit) while its delivered
    // follow-up still sits `joining`. The sandbox's late report then claims
    // the follow-up joined. Honoring it would terminalize a message that
    // never ran and will never be promoted — swallowed outright. The gate
    // makes a lost close settle NOTHING; promotion runs the message instead.
    const s = await seedDeliveredSteer("settle-lost-close");
    await backdate(
      s.target.id,
      "created_at",
      new Date(Date.now() - 40 * 60_000),
    );
    await dueWork.reclaimStaleTurns();
    const target = await db.turn.findUnique({ where: { id: s.target.id } });
    expect(target?.status).toBe("failed");

    await turns.finishTurn({
      reporter: reporter(RUNNER_A, s.sandboxId),
      conversationId: s.conversationId,
      turnId: s.target.id,
      status: "done",
      followUps: [{ turnId: s.followUpId, outcome: "joined" }],
    });

    const row = await db.turn.findUnique({ where: { id: s.followUpId } });
    expect(row?.status).toBe("joining"); // untouched — promotion owns it
    expect((await followUps.promoteParkedFollowUps()) >= 1).toBe(true);
    const promoted = await db.turn.findUnique({ where: { id: s.followUpId } });
    expect(promoted?.status).toBe("queued");
  });

  it("an aborted close SWEEPS the still-joining follow-ups (Stop means silence)", async () => {
    const s = await seedDeliveredSteer("settle-abort-sweep");
    // A second, undelivered follow-up lands in the request→confirm window.
    const late = await followUps.sendConversationMessage(
      WORKSPACE,
      s.conversationId,
      "late arrival",
      WEB_A,
    );

    await turns.finishTurn({
      reporter: reporter(RUNNER_A, s.sandboxId),
      conversationId: s.conversationId,
      turnId: s.target.id,
      status: "aborted",
      // The delivered one genuinely joined before the cancel landed.
      followUps: [{ turnId: s.followUpId, outcome: "joined" }],
    });

    const joined = await db.turn.findUnique({ where: { id: s.followUpId } });
    const swept = await db.turn.findUnique({ where: { id: late.turn.id } });
    expect(joined?.status).toBe("joined"); // the injection happened
    expect(swept?.status).toBe("aborted"); // the rest die with the Stop
  });
});

describe.skipIf(!PROOF_URL)("promotion", () => {
  it("the close promotes the oldest parked follow-up inline, stamping its own clock", async () => {
    const { conversationId, sandboxId } = await seedTalkable("promo-inline");
    const target = await seedActiveTurn(conversationId);
    const first = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "first",
      WEB_A,
    );
    const second = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "second",
      WEB_A,
    );

    await turns.finishTurn({
      reporter: reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId: target.id,
      status: "done",
    });

    const firstRow = await db.turn.findUnique({ where: { id: first.turn.id } });
    const secondRow = await db.turn.findUnique({
      where: { id: second.turn.id },
    });
    expect(firstRow?.status).toBe("queued"); // the OLDEST runs next
    expect(firstRow?.promotedAt).not.toBeNull();
    expect(secondRow?.status).toBe("joining"); // waits for first's close
  });

  it("the poll backstop promotes what the close window lost", async () => {
    const { conversationId } = await seedTalkable("promo-backstop");
    // A parked follow-up whose target is already terminal, with no active
    // turn — the crash-between-close-and-promote state.
    const target = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "t",
      WEB_A,
    );
    await db.turn.update({
      where: { id: target.id },
      data: { status: "done", finishedAt: new Date() },
    });
    const parked = await db.turn.create({
      data: {
        conversationId,
        message: "stranded",
        status: "joining",
        followUpOfTurnId: target.id,
        source: "web",
        userId: USER_A,
      },
      select: { id: true },
    });

    const promoted = await followUps.promoteParkedFollowUps();

    expect(promoted).toBe(1);
    const row = await db.turn.findUnique({ where: { id: parked.id } });
    expect(row?.status).toBe("queued");
  });

  it("loses the index race to an active turn and leaves the row parked", async () => {
    const { conversationId } = await seedTalkable("promo-race");
    const target = await seedActiveTurn(conversationId);
    await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "parked",
      WEB_A,
    );
    void target;

    // The target is still ACTIVE: promotion must lose on the partial index
    // and answer false — never throw, never flip the row.
    const promoted = await turns.promoteOldestParkedFollowUp(conversationId);

    expect(promoted).toBe(false);
    const rows = await db.turn.findMany({
      where: { conversationId, status: "joining" },
    });
    expect(rows).toHaveLength(1);
  });

  it("promotion wakes a PARKED sandbox (the createTurn tail)", async () => {
    const { conversationId, sandboxId } = await seedTalkable("promo-wake");
    const target = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "t",
      WEB_A,
    );
    await db.turn.update({
      where: { id: target.id },
      data: { status: "done", finishedAt: new Date() },
    });
    await db.turn.create({
      data: {
        conversationId,
        message: "wake me",
        status: "joining",
        followUpOfTurnId: target.id,
        source: "web",
        userId: USER_A,
      },
    });
    await db.sandbox.update({
      where: { id: sandboxId },
      data: { status: "stopped" },
    });

    await turns.promoteOldestParkedFollowUp(conversationId);

    const sandbox = await db.sandbox.findUnique({ where: { id: sandboxId } });
    expect(sandbox?.status).toBe("unprovisioned");
  });
});

describe.skipIf(!PROOF_URL)("Stop means silence", () => {
  it("aborting the ACTIVE turn cancels the parked follow-ups too", async () => {
    const { conversationId } = await seedTalkable("abort-cascade");
    const target = await seedActiveTurn(conversationId);
    const parked = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "cancel me too",
      WEB_A,
    );

    await turns.abortTurn(WORKSPACE, target.id, USER_A);

    const row = await db.turn.findUnique({ where: { id: parked.turn.id } });
    expect(row?.status).toBe("aborted");
    const targetRow = await db.turn.findUnique({ where: { id: target.id } });
    expect(targetRow?.abortRequested).toBe(true);
  });

  it("aborting a QUEUED turn abandons it AND its follow-ups outright", async () => {
    const { conversationId } = await seedTalkable("abort-queued");
    const queued = await turns.createTurn(
      WORKSPACE,
      conversationId,
      "q",
      WEB_A,
    );
    const parked = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "riding a queued turn",
      WEB_A,
    );

    await turns.abortTurn(WORKSPACE, queued.id, USER_A);

    const rows = await db.turn.findMany({
      where: { id: { in: [queued.id, parked.turn.id] } },
    });
    expect(rows.map((r) => r.status)).toEqual(["aborted", "aborted"]);
  });

  it("aborting a JOINING follow-up directly works — no false 'already finished'", async () => {
    const { conversationId } = await seedTalkable("abort-direct");
    await seedActiveTurn(conversationId);
    const parked = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "take it back",
      WEB_A,
    );

    const result = await turns.abortTurn(WORKSPACE, parked.turn.id, USER_A);

    expect(result).toEqual({ aborted: true, delivered: false });
    const row = await db.turn.findUnique({ where: { id: parked.turn.id } });
    expect(row?.status).toBe("aborted");
  });
});

describe.skipIf(!PROOF_URL)("the ceiling-warning arm", () => {
  /** Push a running turn's ceiling clock into the warning window (older
   * than ceiling − warning, younger than the ceiling itself). */
  const ageIntoWarningWindow = async (turnId: string) => {
    await db.$executeRaw`UPDATE turns SET created_at = now() - interval '28 minutes' WHERE id = ${turnId}`;
  };

  it("steers ONE wrap-up warning into a run approaching the ceiling", async () => {
    const { conversationId, sandboxId } = await seedTalkable("warn-basic");
    const target = await seedActiveTurn(conversationId);
    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      target.id,
      [{ type: "turn.started" }],
    );
    await ageIntoWarningWindow(target.id);

    const claimed = await dueWork.claimDueWork(RUNNER_A, 10);
    const warning = claimed.find((c) => c.kind === "turn.message");
    expect(warning).toMatchObject({
      kind: "turn.message",
      turnId: `ceiling-warning:${target.id}`,
      targetTurnId: target.id,
      conversationId,
      sandboxId,
      message: V.TURN_CEILING_WARNING_MESSAGE,
    });
    const row = await db.turn.findUnique({ where: { id: target.id } });
    expect(row?.ceilingWarnedAt).not.toBeNull();

    // AT MOST ONCE: the stamp fences a second poll out.
    const second = await dueWork.claimDueWork(RUNNER_A, 10);
    expect(second.some((c) => c.kind === "turn.message")).toBe(false);
  });

  it("leaves a run still comfortably inside its budget alone", async () => {
    const { conversationId, sandboxId } = await seedTalkable("warn-young");
    const target = await seedActiveTurn(conversationId);
    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      target.id,
      [{ type: "turn.started" }],
    );

    const claimed = await dueWork.claimDueWork(RUNNER_A, 10);
    expect(claimed.some((c) => c.kind === "turn.message")).toBe(false);
    const row = await db.turn.findUnique({ where: { id: target.id } });
    expect(row?.ceilingWarnedAt).toBeNull();
  });

  it("a turn.result outcome for the synthetic warning id settles NOTHING", async () => {
    // The warning has no follow-up row, so a supervisor that reports a
    // steer outcome for `ceiling-warning:<id>` must be a harmless no-op —
    // the settle's where-clause simply matches nothing. MUTATION-PROOF for
    // the comment in due-work's warning arm.
    const { conversationId, sandboxId } = await seedTalkable("warn-settle");
    const target = await seedActiveTurn(conversationId);
    await turns.applyTurnEvents(
      reporter(RUNNER_A, sandboxId),
      conversationId,
      target.id,
      [{ type: "turn.started" }],
    );
    await ageIntoWarningWindow(target.id);
    const claimed = await dueWork.claimDueWork(RUNNER_A, 10);
    const warning = claimed.find((c) => c.kind === "turn.message");
    expect(warning?.turnId).toBe(`ceiling-warning:${target.id}`);

    // The close reports the warning "joined", the way a real supervisor
    // reports every steered id it consumed.
    await turns.finishTurn({
      reporter: reporter(RUNNER_A, sandboxId),
      conversationId,
      turnId: target.id,
      status: "done",
      followUps: [
        { turnId: `ceiling-warning:${target.id}`, outcome: "joined" },
      ],
    });

    const closed = await db.turn.findUnique({ where: { id: target.id } });
    expect(closed?.status).toBe("done");
    // No stray row was created or mutated by the synthetic outcome.
    const strays = await db.turn.findMany({
      where: { conversationId, id: { not: target.id } },
    });
    expect(strays).toEqual([]);
  });

  it("never warns through a runner that cannot parse turn.message", async () => {
    // The version-skew gate, same as the steer arm's: an old runner's poll
    // parse is all-or-nothing, so the warning must simply not exist for it.
    const { conversationId, sandboxId } = await seedTalkable(
      "warn-oldrunner",
      RUNNER_OLD,
    );
    const target = await seedActiveTurn(conversationId, RUNNER_OLD);
    await turns.applyTurnEvents(
      reporter(RUNNER_OLD, sandboxId),
      conversationId,
      target.id,
      [{ type: "turn.started" }],
    );
    await ageIntoWarningWindow(target.id);

    const claimed = await dueWork.claimDueWork(RUNNER_OLD, 10);
    expect(claimed.some((c) => c.kind === "turn.message")).toBe(false);
    // And the fence was NOT spent: the row stays warnable if the runner
    // upgrades before the ceiling.
    const row = await db.turn.findUnique({ where: { id: target.id } });
    expect(row?.ceilingWarnedAt).toBeNull();
  });
});

describe.skipIf(!PROOF_URL)("the sweeps", () => {
  it("a PROMOTED follow-up measures its ceiling from promotion, not birth", async () => {
    const { conversationId } = await seedTalkable("sweep-promoted");
    const target = await seedActiveTurn(conversationId);
    const sent = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "old but fresh",
      WEB_A,
    );
    await db.turn.update({
      where: { id: target.id },
      data: { status: "done", finishedAt: new Date() },
    });
    await db.turn.update({
      where: { id: sent.turn.id },
      data: { status: "queued", promotedAt: new Date() },
    });
    // Born 40 minutes ago — past the 30-minute ceiling — but promoted NOW.
    await backdate(
      sent.turn.id,
      "created_at",
      new Date(Date.now() - 40 * 60_000),
    );

    await dueWork.reclaimStaleTurns();

    const fresh = await db.turn.findUnique({ where: { id: sent.turn.id } });
    expect(fresh?.status).toBe("queued"); // its own clock has barely started

    // Now age the promotion clock too: swept like any over-ceiling turn.
    await backdate(
      sent.turn.id,
      "promoted_at",
      new Date(Date.now() - 40 * 60_000),
    );
    await dueWork.reclaimStaleTurns();
    const swept = await db.turn.findUnique({ where: { id: sent.turn.id } });
    expect(swept?.status).toBe("failed");
  });

  it("the wedge sweep NEVER touches a follow-up parked behind a live turn", async () => {
    // A row waiting on an active turn is healthy by definition — that turn
    // is itself ceiling-bounded. Sweeping it would kill legitimate queue
    // members ("parked behind one long turn plus a promoted predecessor").
    const { conversationId } = await seedTalkable("sweep-protected");
    await seedActiveTurn(conversationId);
    const sent = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "old but healthy",
      WEB_A,
    );
    await backdate(
      sent.turn.id,
      "created_at",
      new Date(Date.now() - 40 * 60_000),
    );

    await dueWork.expireWedgedFollowUps();

    const row = await db.turn.findUnique({ where: { id: sent.turn.id } });
    expect(row?.status).toBe("joining");
  });

  it("the poll order protects an aged row the conversation can still run: promote, THEN sweep", async () => {
    // The same-pass race: a long turn hits its ceiling, freeing the
    // conversation, in the very poll that would also sweep its aged
    // follow-up. Promotion runs first and re-occupies the conversation, so
    // the sweep finds nothing to bury.
    const { conversationId } = await seedTalkable("sweep-promote-first");
    const target = await seedActiveTurn(conversationId);
    const sent = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "aged with a future",
      WEB_A,
    );
    await backdate(
      sent.turn.id,
      "created_at",
      new Date(Date.now() - 40 * 60_000),
    );
    await backdate(target.id, "created_at", new Date(Date.now() - 41 * 60_000));

    // The poll sequence, in its real order.
    await dueWork.reclaimStaleTurns(); // ceiling-fails the target
    await followUps.promoteParkedFollowUps(); // re-occupies the conversation
    await dueWork.expireWedgedFollowUps(); // finds nothing wedged

    const row = await db.turn.findUnique({ where: { id: sent.turn.id } });
    expect(row?.status).toBe("queued"); // promoted, not buried
  });

  it("a GENUINELY wedged follow-up ages out with its own words", async () => {
    const { conversationId } = await seedTalkable("sweep-joining");
    const target = await seedActiveTurn(conversationId);
    const sent = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "wedged",
      WEB_A,
    );
    // The target dies without settling and, unlike the healthy path,
    // promotion cannot run this row (simulated: the row aged a whole
    // ceiling while nothing promoted it — the crashed-promotion state).
    await db.turn.update({
      where: { id: target.id },
      data: { status: "failed", finishedAt: new Date() },
    });
    await backdate(
      sent.turn.id,
      "created_at",
      new Date(Date.now() - 40 * 60_000),
    );

    await dueWork.expireWedgedFollowUps();

    const row = await db.turn.findUnique({ where: { id: sent.turn.id } });
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe(V.FOLLOW_UP_EXPIRED_MESSAGE);
  });

  it("an unstartable park fails the parked follow-ups with the same actionable reason", async () => {
    const { agentId, conversationId } = await seedTalkable("sweep-park");
    const target = await seedActiveTurn(conversationId);
    const sent = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "waiting on a key",
      WEB_A,
    );
    void target;
    // The park path: the sandbox claim is `starting` when compose refuses.
    await db.sandbox.updateMany({
      where: { agentId },
      data: { status: "starting" },
    });
    const sandbox = await db.sandbox.findFirst({
      where: { agentId },
      select: { id: true },
    });

    await dueWork.parkUnstartableClaim(sandbox?.id ?? "", RUNNER_A, {
      message: V.NO_MODEL_KEY_MESSAGE,
      code: "no_model_key",
    });

    const row = await db.turn.findUnique({ where: { id: sent.turn.id } });
    expect(row?.status).toBe("failed");
    expect(row?.errorCode).toBe("no_model_key");
  });
});
