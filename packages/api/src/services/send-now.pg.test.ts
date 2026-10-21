import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * SEND NOW on REAL PostgreSQL: the request door and the
 * claim arm that carries it to the sandbox.
 *
 * - **The door** (`requestSendNow`) sets a one-shot flag on a WAITING
 *   follow-up whose run is still live, fenced exactly like Stop: a foreign
 *   tenant or a foreign direct thread reads NOT_FOUND. Everything that
 *   makes the request meaningless is a plain CONFLICT: already read, the
 *   run ended, or the message (or one ahead of it) carries files and so
 *   never joins a live run.
 * - **The claim arm** hands the request over only once the message was
 *   DELIVERED to the run, only while that run is RUNNING, only through a
 *   runner that advertised `sendNow`, and only once (the flag clears in
 *   the same statement). In one poll a delivery and its request come out
 *   delivery-first.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Conversations = typeof import("./conversation-service");
type Turns = typeof import("./turn-service");
type FollowUps = typeof import("./follow-up-service");
type DueWork = typeof import("./due-work");

let db: Db;
let conversations: Conversations;
let turns: Turns;
let followUps: FollowUps;
let dueWork: DueWork;

const P = "sendnow-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const OTHER_WORKSPACE = `${P}proj-other`;
const RUNNER_A = `${P}runner-a`;
/** Steers, but predates SEND NOW: never handed a `turn.send_now`. */
const RUNNER_OLD = `${P}runner-old`;
/** Steers and sends now, but predates delivering a follow-up's files. */
const RUNNER_PRE_FILES = `${P}runner-pre-files`;
const USER_A = `${P}user-a`;
const USER_B = `${P}user-b`;

const WEB_A = { source: "web", userId: USER_A } as const;

const reset = async () => {
  await db.sandbox.deleteMany({
    where: { runnerId: { in: [RUNNER_A, RUNNER_OLD, RUNNER_PRE_FILES] } },
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
  // A key grant, as the product makes one: dispatch refuses a keyless agent.
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
  return agent.id;
};

const reporter = (runnerId: string, sandboxId: string) => ({
  runnerId,
  sandboxId,
});

/**
 * Agent + running sandbox + a turn RUNNING its run + a waiting follow-up,
 * delivered unless told otherwise: the state SEND NOW exists for.
 */
const seedWaiting = async (
  suffix: string,
  options: { runnerId?: string; deliver?: boolean; run?: boolean } = {},
) => {
  const runnerId = options.runnerId ?? RUNNER_A;
  const agentId = await seedAgent(suffix);
  const sandbox = await db.sandbox.create({
    data: {
      agentId,
      runnerId,
      status: "running",
      lastActiveAt: new Date(),
      homeAppliedGeneration: 1,
    },
    select: { id: true },
  });
  const conversation = await conversations.createConversation(WORKSPACE, {
    agentId,
  });
  const conversationId = conversation.id;
  const target = await turns.createTurn(
    WORKSPACE,
    conversationId,
    "long build",
    WEB_A,
  );
  await dueWork.claimDueWork(runnerId, 10); // dispatched
  if (options.run !== false) {
    await turns.applyTurnEvents(
      reporter(runnerId, sandbox.id),
      conversationId,
      target.id,
      [{ type: "turn.started" }],
    );
  }
  const sent = await followUps.sendConversationMessage(
    WORKSPACE,
    conversationId,
    "stop and check prod",
    WEB_A,
  );
  if (options.deliver !== false) {
    const claimed = await dueWork.claimDueWork(runnerId, 10);
    expect(claimed.some((c) => c.kind === "turn.message")).toBe(true);
  }
  return {
    agentId,
    sandboxId: sandbox.id,
    conversationId,
    targetId: target.id,
    followUpId: sent.turn.id,
  };
};

const sendNowsIn = (claimed: Awaited<ReturnType<DueWork["claimDueWork"]>>) =>
  claimed.filter((c) => c.kind === "turn.send_now");

const flag = async (turnId: string) =>
  (
    await db.turn.findUniqueOrThrow({
      where: { id: turnId },
      select: { sendNowRequested: true },
    })
  ).sendNowRequested;

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SANDBOX_IDLE_STOP_SECONDS = "600";
  process.env.GATEWAY_CA_CERT =
    "-----BEGIN CERTIFICATE-----\ntest-ca\n-----END CERTIFICATE-----";

  ({ db } = await import("@onecli/db"));
  conversations = await import("./conversation-service");
  turns = await import("./turn-service");
  followUps = await import("./follow-up-service");
  dueWork = await import("./due-work");

  await reset();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.createMany({
    data: [
      { id: WORKSPACE, name: "Send Now Workspace", organizationId: ORG },
      { id: OTHER_WORKSPACE, name: "Other Workspace", organizationId: ORG },
    ],
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
    where: { runnerId: { in: [RUNNER_A, RUNNER_OLD, RUNNER_PRE_FILES] } },
  });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
  const base = {
    maxSandboxes: 8,
    backend: "docker",
    homeDurability: "resident",
    steerMessages: true,
  };
  await db.runner.createMany({
    data: [
      {
        id: RUNNER_A,
        name: "send-now-capable",
        token: `rnr_${P}a`,
        capabilities: { ...base, sendNow: true, steerAttachments: true },
      },
      {
        id: RUNNER_PRE_FILES,
        name: "send-now-pre-files",
        token: `rnr_${P}pre-files`,
        capabilities: { ...base, sendNow: true },
      },
      {
        id: RUNNER_OLD,
        name: "pre-send-now",
        token: `rnr_${P}old`,
        capabilities: base,
      },
    ],
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

describe.skipIf(!PROOF_URL)("the SEND NOW door", () => {
  it("flags a waiting follow-up on a running turn, and repeating it is harmless", async () => {
    const s = await seedWaiting("door-ok");
    await expect(
      turns.requestSendNow(WORKSPACE, s.followUpId, USER_A),
    ).resolves.toEqual({ requested: true });
    await expect(
      turns.requestSendNow(WORKSPACE, s.followUpId, USER_B),
    ).resolves.toEqual({ requested: true });
    expect(await flag(s.followUpId)).toBe(true);
  });

  it("is accepted BEFORE delivery too: the request waits for the delivery", async () => {
    const s = await seedWaiting("door-early", { deliver: false });
    await expect(
      turns.requestSendNow(WORKSPACE, s.followUpId, USER_A),
    ).resolves.toEqual({ requested: true });
  });

  it("reads NOT_FOUND across tenants, for a foreign direct thread, and for an unknown id", async () => {
    const s = await seedWaiting("door-fence");
    await expect(
      turns.requestSendNow(OTHER_WORKSPACE, s.followUpId, USER_A),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      turns.requestSendNow(WORKSPACE, `${P}nope`, USER_A),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // A direct thread is its owner's alone, like Stop.
    const direct = await conversations.ensureDirectConversation(
      WORKSPACE,
      s.agentId,
      USER_A,
      "web",
    );
    await db.turn.updateMany({
      where: { conversationId: s.conversationId },
      data: { conversationId: direct.id },
    });
    await expect(
      turns.requestSendNow(WORKSPACE, s.followUpId, USER_B),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await flag(s.followUpId)).toBe(false);
  });

  it("CONFLICT once read: the agent already has it", async () => {
    const s = await seedWaiting("door-read");
    await turns.applyTurnEvents(
      reporter(RUNNER_A, s.sandboxId),
      s.conversationId,
      s.targetId,
      [{ type: "message.joined", followUpId: s.followUpId }],
    );
    await expect(
      turns.requestSendNow(WORKSPACE, s.followUpId, USER_A),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "The agent already has this message",
    });
  });

  it("CONFLICT once the run ended: nothing is reading any more", async () => {
    const s = await seedWaiting("door-ended");
    // A finished target whose follow-up has not been promoted yet (the
    // close window): the row still says joining.
    await db.turn.update({
      where: { id: s.targetId },
      data: { status: "done" },
    });
    await expect(
      turns.requestSendNow(WORKSPACE, s.followUpId, USER_A),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "The agent finished before it could read this message",
    });
    expect(await flag(s.followUpId)).toBe(false);
  });

  it("CONFLICT for an ordinary turn (not a waiting message)", async () => {
    const s = await seedWaiting("door-turn");
    await expect(
      turns.requestSendNow(WORKSPACE, s.targetId, USER_A),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  /** A waiting message with one file, then a text message sent after it. */
  const sendFileThenText = async (conversationId: string) => {
    const attachment = await db.conversationAttachment.create({
      data: {
        conversationId,
        userId: USER_A,
        source: "web",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        sha256: "a".repeat(64),
        data: Buffer.from("abc"),
        status: "pending",
      },
      select: { id: true },
    });
    const withFile = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "see attached",
      WEB_A,
      [attachment.id],
    );
    const behind = await followUps.sendConversationMessage(
      WORKSPACE,
      conversationId,
      "and this",
      WEB_A,
    );
    return [withFile.turn.id, behind.turn.id];
  };

  it("a message with files, and one sent after it, can be read now: both join the live run", async () => {
    const s = await seedWaiting("door-files");
    for (const id of await sendFileThenText(s.conversationId)) {
      await expect(
        turns.requestSendNow(WORKSPACE, id, USER_A),
      ).resolves.toEqual({ requested: true });
      expect(await flag(id)).toBe(true);
    }
  });

  it("CONFLICT for a message with files, and for one sent after it, when the runner cannot deliver files into a live run", async () => {
    // MUTATION-TESTED: drop the capability check and this accepts a request
    // for messages that wait for the run to end, a click that can do nothing.
    const s = await seedWaiting("door-files-old", {
      runnerId: RUNNER_PRE_FILES,
    });
    for (const id of await sendFileThenText(s.conversationId)) {
      await expect(
        turns.requestSendNow(WORKSPACE, id, USER_A),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "Messages with files are read once the agent finishes",
      });
      expect(await flag(id)).toBe(false);
    }
    // The one AHEAD of the file is unaffected.
    await expect(
      turns.requestSendNow(WORKSPACE, s.followUpId, USER_A),
    ).resolves.toEqual({ requested: true });
  });
});

describe.skipIf(!PROOF_URL)("the SEND NOW claim arm", () => {
  it("hands over a delivered, waiting request on a running turn ONCE, clearing the flag", async () => {
    const s = await seedWaiting("claim-once");
    await turns.requestSendNow(WORKSPACE, s.followUpId, USER_A);

    const first = await dueWork.claimDueWork(RUNNER_A, 10);
    expect(sendNowsIn(first)).toEqual([
      {
        kind: "turn.send_now",
        turnId: s.followUpId,
        targetTurnId: s.targetId,
        conversationId: s.conversationId,
        sandboxId: s.sandboxId,
      },
    ]);
    expect(await flag(s.followUpId)).toBe(false);
    expect(sendNowsIn(await dueWork.claimDueWork(RUNNER_A, 10))).toEqual([]);
  });

  it("waits for DELIVERY, then a delivery and its request come out in one poll, delivery FIRST", async () => {
    const s = await seedWaiting("claim-order", { deliver: false });
    await turns.requestSendNow(WORKSPACE, s.followUpId, USER_A);

    const claimed = await dueWork.claimDueWork(RUNNER_A, 10);
    const kinds = claimed.map((c) => c.kind);
    expect(kinds.indexOf("turn.message")).toBeGreaterThan(-1);
    expect(kinds.indexOf("turn.send_now")).toBeGreaterThan(
      kinds.indexOf("turn.message"),
    );
  });

  it("an undelivered request WAITS, flag intact, until the delivery happens", async () => {
    // MUTATION-PROOF for `steer_delivered_at IS NOT NULL`: on a runner that
    // cannot steer yet the message is never handed to the run, so moving a
    // tool would let in nothing. The request must wait, not be spent.
    const s = await seedWaiting("claim-undelivered", { deliver: false });
    await db.runner.update({
      where: { id: RUNNER_A },
      data: {
        capabilities: {
          maxSandboxes: 8,
          backend: "docker",
          homeDurability: "resident",
          sendNow: true,
        },
      },
    });
    await turns.requestSendNow(WORKSPACE, s.followUpId, USER_A);
    expect(sendNowsIn(await dueWork.claimDueWork(RUNNER_A, 10))).toEqual([]);
    expect(await flag(s.followUpId)).toBe(true);
  });

  it("waits while the turn is only DISPATCHED: there is no tool to move yet", async () => {
    const s = await seedWaiting("claim-dispatched", { run: false });
    await turns.requestSendNow(WORKSPACE, s.followUpId, USER_A);
    expect(sendNowsIn(await dueWork.claimDueWork(RUNNER_A, 10))).toEqual([]);
    expect(await flag(s.followUpId)).toBe(true);

    await turns.applyTurnEvents(
      reporter(RUNNER_A, s.sandboxId),
      s.conversationId,
      s.targetId,
      [{ type: "turn.started" }],
    );
    expect(sendNowsIn(await dueWork.claimDueWork(RUNNER_A, 10))).toHaveLength(
      1,
    );
  });

  it("never hands over a request for a message already read", async () => {
    const s = await seedWaiting("claim-read");
    await turns.requestSendNow(WORKSPACE, s.followUpId, USER_A);
    await turns.applyTurnEvents(
      reporter(RUNNER_A, s.sandboxId),
      s.conversationId,
      s.targetId,
      [{ type: "message.joined", followUpId: s.followUpId }],
    );
    expect(sendNowsIn(await dueWork.claimDueWork(RUNNER_A, 10))).toEqual([]);
  });

  it("never through a runner that did not advertise sendNow, nor another runner's", async () => {
    const s = await seedWaiting("claim-skew", { runnerId: RUNNER_OLD });
    await turns.requestSendNow(WORKSPACE, s.followUpId, USER_A);
    expect(sendNowsIn(await dueWork.claimDueWork(RUNNER_OLD, 10))).toEqual([]);
    expect(sendNowsIn(await dueWork.claimDueWork(RUNNER_A, 10))).toEqual([]);
    expect(await flag(s.followUpId)).toBe(true);
  });

  it("Stop after SEND NOW: the aborted message's request is never handed over", async () => {
    const s = await seedWaiting("claim-stop", { deliver: false });
    await turns.requestSendNow(WORKSPACE, s.followUpId, USER_A);
    await turns.abortTurn(WORKSPACE, s.followUpId, USER_A);
    const claimed = await dueWork.claimDueWork(RUNNER_A, 10);
    expect(sendNowsIn(claimed)).toEqual([]);
  });

  it("two waiting messages: only the requested one is handed over", async () => {
    const s = await seedWaiting("claim-two");
    const second = await followUps.sendConversationMessage(
      WORKSPACE,
      s.conversationId,
      "second",
      WEB_A,
    );
    await dueWork.claimDueWork(RUNNER_A, 10); // delivers the second
    await turns.requestSendNow(WORKSPACE, second.turn.id, USER_A);
    expect(
      sendNowsIn(await dueWork.claimDueWork(RUNNER_A, 10)).map((c) => c.turnId),
    ).toEqual([second.turn.id]);
    expect(await flag(s.followUpId)).toBe(false);
  });
});
