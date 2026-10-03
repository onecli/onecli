import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../../testing/pg-proof.js";

/**
 * Agent-to-agent messaging (PR 5b) — proofs against a real DB:
 *
 *  - ask/ask (the pristine pair): one message opens TWO holds, one per
 *    agent, same frozen payload; nothing lands yet;
 *  - both approve: the SECOND approve delivers - one framed `Name (agent):`
 *    turn on the receiver's pair conversation (`source: "agent"`,
 *    `externalRef` = sender id, `userId` null), and the streak counts it;
 *  - one side rejects: the other side's approve cannot deliver alone (the
 *    approval settles failed), no turn;
 *  - blocked on either side: the tool refuses up front, no hold, no turn;
 *  - allow/allow: delivered immediately, no hold;
 *  - "approve + always allow" sets the DECIDER's side only;
 *  - the fence: a name resolves inside the sender's workspace only; an id
 *    reaches anywhere; never the sender itself; a foreign workspace cannot
 *    set a link policy for an agent it does not own;
 *  - verify at replay: a block landing after the cards refuses the approve;
 *  - the cap: agent turns on the pair conversation cross at the same cap
 *    and the continue card's summary names the thread;
 *  - peer tasks (the PR after 5b): a person's ask opens a bounded task on
 *    the pair, the exchange stays on the pair conversations, complete_task
 *    reports once into the person's conversation, the backstops (budget,
 *    idle, block/remove) close with a line, one open task per pair with a
 *    FIFO queue, the approval replay opens the frozen task, the fences.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Links = typeof import("./agent-link-service");
type Roster = typeof import("./agent-peer-roster");
type Cap = typeof import("./app-turn-cap-service");
type Tasks = typeof import("./peer-task-service");
type Approvals = typeof import("./action-approval-service");
type PlatformTools = typeof import("../platform-tool-service");

let db: Db;
let links: Links;
let roster: Roster;
let cap: Cap;
let tasks: Tasks;
let approvals: Approvals;
let platformTools: PlatformTools;
let app: ReturnType<typeof import("../../app").createApiApp>;

/** The signed-in dashboard caller (the routes leg). */
let currentSession: { id: string; email: string } | null = null;

const P = "a2a-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OTHER_WORKSPACE = `${P}ws2`;
const OWNER = `${P}owner`;

let llmServer: Server;

/** The fake LLM endpoint the sandbox would call; never reached here (the
 *  fake harness runs no model) but the env must point somewhere. */
const startFake = (): Promise<string> =>
  new Promise((resolve) => {
    llmServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    llmServer.listen(0, "127.0.0.1", () => {
      const { port } = llmServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

// ── Seeds ───────────────────────────────────────────────────────────────────

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

const seedAgent = async (name: string, workspaceId = WORKSPACE) => {
  const suffix = `${name.toLowerCase().replace(/\s+/g, "-")}-${workspaceId}`;
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name,
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true, name: true, workspaceId: true },
  });
  await grantLlmKey(agent.id, suffix);
  return agent;
};

/** Donna and Ray, same workspace, no link row yet. */
const seedPair = async () => {
  const donna = await seedAgent("Donna");
  const ray = await seedAgent("Ray");
  return { donna, ray };
};

const message = (from: { id: string }, to: string, text = "hello there") =>
  links.requestCommunicate({
    fromAgentId: from.id,
    to,
    text,
    originConversationId: null,
    originTurnId: null,
  });

const holdsFor = (agentId: string) =>
  db.actionApproval.findMany({
    where: { agentId, action: links.AGENT_COMMUNICATE_ACTION },
    orderBy: { createdAt: "asc" },
  });

const pairConversationOf = (agentId: string, peerId: string) =>
  db.conversation.findFirst({
    where: { agentId, source: "agent", externalRef: peerId },
    select: { id: true, title: true, appTurnStreak: true },
  });

const turnsOf = (agentId: string) =>
  db.turn.findMany({
    where: { conversation: { agentId, source: "agent" } },
    orderBy: { createdAt: "asc" },
  });

const approve = (
  approvalId: string,
  decision: "approve" | "approve_always" | "reject" = "approve",
) =>
  approvals.decideActionApproval({
    approvalId,
    decision,
    deciderUserId: OWNER,
  });

const reset = async () => {
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
  await db.policyRuleTarget.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleIdentity.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleV2.deleteMany({ where: { logicalId: { startsWith: P } } });
  await db.secret.deleteMany({ where: { name: { startsWith: P } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  const fakeUrl = await startFake();
  process.env.DATABASE_URL = PROOF_URL;
  process.env.ANTHROPIC_API_BASE_URL = fakeUrl;
  process.env.OPENAI_API_BASE_URL = fakeUrl;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  ({ db } = await import("@onecli/db"));
  links = await import("./agent-link-service");
  roster = await import("./agent-peer-roster");
  cap = await import("./app-turn-cap-service");
  tasks = await import("./peer-task-service");
  approvals = await import("./action-approval-service");
  platformTools = await import("../platform-tool-service");
  const providers = await import("../../providers");
  providers.initSelfUrl("https://api.a2a.test");
  const { createApiApp } = await import("../../app");
  app = createApiApp(
    { getSession: async () => currentSession },
    { selfUrl: "https://api.a2a.test" },
  );

  await reset();
  await db.workspaceAccess.deleteMany({
    where: { workspaceId: { in: [WORKSPACE, OTHER_WORKSPACE] } },
  });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({
    where: { id: { in: [WORKSPACE, OTHER_WORKSPACE] } },
  });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });

  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "A2A", organizationId: ORG },
  });
  await db.workspace.create({
    data: { id: OTHER_WORKSPACE, name: "A2A Other", organizationId: ORG },
  });
  await db.user.create({
    data: {
      id: OWNER,
      email: `${OWNER}@example.com`,
      externalAuthId: OWNER,
      name: "Olive Owner",
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
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await reset();
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await new Promise<void>((resolve) => llmServer.close(() => resolve())).catch(
    () => {},
  );
});

// ── The consent walk ────────────────────────────────────────────────────────

describe.skipIf(!PROOF_URL)("agent links (5b) — the consent walk", () => {
  it("ask/ask: one message opens TWO holds (one per agent), same frozen payload, nothing lands", async () => {
    const { donna, ray } = await seedPair();
    const outcome = await message(donna, "Ray", "can you check the deploy?");
    expect(outcome.kind).toBe("held");
    if (outcome.kind !== "held") throw new Error("unreachable");
    expect(outcome.to).toBe("Ray");
    expect(outcome.approvalIds).toHaveLength(2);

    const [mine] = await holdsFor(donna.id);
    const [theirs] = await holdsFor(ray.id);
    expect(mine?.status).toBe("pending");
    expect(theirs?.status).toBe("pending");
    expect(mine?.payload).toEqual(theirs?.payload);
    expect(mine?.payload).toEqual({
      fromAgentId: donna.id,
      toAgentId: ray.id,
      text: "can you check the deploy?",
    });
    expect(mine?.summary).toBe(
      'Donna wants to talk to Ray: "can you check the deploy?"',
    );
    expect(await turnsOf(ray.id)).toHaveLength(0);
    // The pair row exists, pristine.
    const link = await db.agentLink.findFirstOrThrow({
      where: {
        OR: [
          { agentAId: donna.id, agentBId: ray.id },
          { agentAId: ray.id, agentBId: donna.id },
        ],
      },
    });
    expect([link.policyA, link.policyB]).toEqual(["ask", "ask"]);
  });

  it("both approve: the SECOND approve delivers one framed turn on the receiver's pair conversation, and the streak counts it", async () => {
    const { donna, ray } = await seedPair();
    await message(donna, "Ray", "ping");
    const [mine] = await holdsFor(donna.id);
    const [theirs] = await holdsFor(ray.id);

    // First approve (the sender's side): waits for the sibling.
    expect(await approve(mine!.id)).toEqual({
      kind: "decided",
      status: "executed",
    });
    expect(await turnsOf(ray.id)).toHaveLength(0);

    // Second approve (the receiver's side): delivers.
    expect(await approve(theirs!.id)).toEqual({
      kind: "decided",
      status: "executed",
    });
    const turns = await turnsOf(ray.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.message).toBe("Donna (agent): ping");
    expect(turns[0]!.userId).toBeNull();
    expect(turns[0]!.source).toBe("agent");

    const inbox = await pairConversationOf(ray.id, donna.id);
    expect(inbox?.title).toBe("Donna");
    expect(inbox?.appTurnStreak).toBe(1);
    // The sender's side records what it said, so its owner can open the
    // pair conversation right after the first message and see the opener.
    const outbox = await pairConversationOf(donna.id, ray.id);
    expect(outbox?.title).toBe("Ray");
    expect(outbox?.appTurnStreak).toBe(0); // its own words never meter it

    // An approve is consent to THIS message, not a person driving the
    // pair: it never resets the receiver's chain. (A person driving does:
    // see the cap arms.)
    await db.conversation.update({
      where: { id: inbox!.id },
      data: { appTurnStreak: 3 },
    });
    await message(donna, "Ray", "again");
    const [, mine2] = await holdsFor(donna.id);
    const [, theirs2] = await holdsFor(ray.id);
    await approve(mine2!.id);
    await approve(theirs2!.id);
    expect((await turnsOf(ray.id)).map((t) => t.message)).toEqual([
      "Donna (agent): ping",
      "Donna (agent): again",
    ]);
    expect((await pairConversationOf(ray.id, donna.id))?.appTurnStreak).toBe(4);
  });

  it("the sender's record: each sent message is a born-done turn on the sender's pair conversation, its words in a structured notice; the reply lands beside it as the peer's turn", async () => {
    const { donna, ray } = await seedPair();
    for (const [a, b] of [
      [donna, ray],
      [ray, donna],
    ] as const) {
      await links.setLinkPolicy({
        workspaceId: WORKSPACE,
        agentId: a.id,
        peerAgentId: b.id,
        policy: "allow",
        deciderUserId: OWNER,
      });
    }
    await message(donna, "Ray", "what is 2+2?");
    await message(ray, "Donna", "4");

    // Donna's side reads as the dialogue: her words, then Ray's.
    const donnaSide = await turnsOf(donna.id);
    expect(donnaSide.map((t) => t.message)).toEqual(["", "Ray (agent): 4"]);
    const record = donnaSide[0]!;
    // Born terminal: never dispatchable, so it can neither trip the
    // one-active-turn index nor reach a sandbox.
    expect(record).toMatchObject({
      status: "done",
      source: "agent",
      userId: null,
    });
    expect(record.startedAt).not.toBeNull();
    expect(record.finishedAt).not.toBeNull();
    const events = await db.turnEvent.findMany({
      where: { turnId: record.id },
      orderBy: { seq: "asc" },
      select: { type: true, payload: true },
    });
    expect(events.map((e) => e.type)).toEqual(["notice", "turn.done"]);
    // The words ride the structured field the pair view reads; the text is
    // the same line the regular transcript shows.
    expect(events[0]!.payload).toEqual({
      type: "notice",
      level: "info",
      text: "To Ray: what is 2+2?",
      peerMessage: { to: ray.id, text: "what is 2+2?" },
    });

    // Ray's side, mirrored: Donna's words as the framed turn, then his own
    // record.
    const raySide = await turnsOf(ray.id);
    expect(raySide.map((t) => t.message)).toEqual([
      "Donna (agent): what is 2+2?",
      "",
    ]);
    // Each side's events are one contiguous seq line from 1 (the record's
    // two events are the only ones here: no sandbox ran), so a live reader
    // tailing from the last seq it saw misses nothing and sees no gap.
    for (const conversationId of [
      donnaSide[0]!.conversationId,
      raySide[0]!.conversationId,
    ]) {
      const seqs = (
        await db.turnEvent.findMany({
          where: { conversationId },
          orderBy: { seq: "asc" },
          select: { seq: true },
        })
      ).map((e) => e.seq);
      expect(seqs).toEqual([1, 2]);
      const { lastSeq } = await db.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: { lastSeq: true },
      });
      expect(lastSeq).toBe(2);
    }
  });

  it("both cards approved CONCURRENTLY: exactly one delivery, never zero, never two", async () => {
    // The race the order rule exists for: at handler time each side reads
    // the other as `approved` (flipped, not yet executed). "The other will
    // deliver" would make both defer; "deliver if the other approved" would
    // make both deliver. The later decision delivers, by decidedAt then id.
    const { donna, ray } = await seedPair();
    await message(donna, "Ray", "race");
    const [mine] = await holdsFor(donna.id);
    const [theirs] = await holdsFor(ray.id);
    const results = await Promise.all([approve(mine!.id), approve(theirs!.id)]);
    expect(results.map((r) => r.kind)).toEqual(["decided", "decided"]);
    expect(
      results.every((r) => r.kind === "decided" && r.status === "executed"),
    ).toBe(true);
    expect((await turnsOf(ray.id)).map((t) => t.message)).toEqual([
      "Donna (agent): race",
    ]);
  });

  it("the deliverer is the LATER decision, whichever side it is", async () => {
    // Sequential, receiver first then sender: the sender's approve (later)
    // must deliver - the rule is order, not side.
    const { donna, ray } = await seedPair();
    await message(donna, "Ray", "order");
    const [mine] = await holdsFor(donna.id);
    const [theirs] = await holdsFor(ray.id);
    await approve(theirs!.id);
    expect(await turnsOf(ray.id)).toHaveLength(0);
    await approve(mine!.id);
    expect(await turnsOf(ray.id)).toHaveLength(1);
  });

  it("one side rejects: the other side's approve cannot deliver alone", async () => {
    const { donna, ray } = await seedPair();
    await message(donna, "Ray");
    const [mine] = await holdsFor(donna.id);
    const [theirs] = await holdsFor(ray.id);

    expect(await approve(theirs!.id, "reject")).toEqual({
      kind: "decided",
      status: "rejected",
    });
    const result = await approve(mine!.id);
    expect(result.kind).toBe("decided");
    if (result.kind !== "decided") throw new Error("unreachable");
    expect(result.status).toBe("failed");
    expect(await turnsOf(ray.id)).toHaveLength(0);
  });

  it("allow/allow: delivered immediately, no hold", async () => {
    const { donna, ray } = await seedPair();
    await links.setLinkPolicy({
      workspaceId: WORKSPACE,
      agentId: donna.id,
      peerAgentId: ray.id,
      policy: "allow",
      deciderUserId: OWNER,
    });
    await links.setLinkPolicy({
      workspaceId: WORKSPACE,
      agentId: ray.id,
      peerAgentId: donna.id,
      policy: "allow",
      deciderUserId: OWNER,
    });
    const outcome = await message(donna, "ray", "hi");
    expect(outcome).toEqual({ kind: "sent", to: "Ray", task: "none" });
    expect(await holdsFor(donna.id)).toHaveLength(0);
    expect(await holdsFor(ray.id)).toHaveLength(0);
    expect((await turnsOf(ray.id)).map((t) => t.message)).toEqual([
      "Donna (agent): hi",
    ]);
  });

  it("allow on ONE side only: exactly one hold, on the asking side", async () => {
    const { donna, ray } = await seedPair();
    await links.setLinkPolicy({
      workspaceId: WORKSPACE,
      agentId: donna.id,
      peerAgentId: ray.id,
      policy: "allow",
      deciderUserId: OWNER,
    });
    const outcome = await message(donna, "Ray");
    expect(outcome.kind).toBe("held");
    expect(await holdsFor(donna.id)).toHaveLength(0);
    expect(await holdsFor(ray.id)).toHaveLength(1);
  });

  it("the nag brake: past MAX_PENDING_PER_PAIR unanswered asks, the tool refuses until one is decided", async () => {
    const { donna, ray } = await seedPair();
    for (let i = 1; i <= links.MAX_PENDING_PER_PAIR; i += 1) {
      expect((await message(donna, "Ray", `ask ${i}`)).kind).toBe("held");
    }
    await expect(message(donna, "Ray", "one more")).rejects.toThrow(
      /already waiting for approval/,
    );
    // Two holds per ask (both sides asked): none for the refused one.
    expect(await holdsFor(ray.id)).toHaveLength(links.MAX_PENDING_PER_PAIR);
    // The brake is per DIRECTION: Ray asking Donna is not counted.
    expect((await message(ray, "Donna", "reverse")).kind).toBe("held");
    // Deciding one frees a slot.
    const [first] = await holdsFor(donna.id);
    await approve(first!.id, "reject");
    expect((await message(donna, "Ray", "after a decision")).kind).toBe("held");
  });

  it("blocked on either side: the tool refuses up front, no hold, no turn", async () => {
    const { donna, ray } = await seedPair();
    await links.setLinkPolicy({
      workspaceId: WORKSPACE,
      agentId: ray.id,
      peerAgentId: donna.id,
      policy: "blocked",
      deciderUserId: OWNER,
    });
    await expect(message(donna, "Ray")).rejects.toThrow(
      "Ray's owner has blocked messages from you",
    );
    expect(await holdsFor(donna.id)).toHaveLength(0);
    expect(await holdsFor(ray.id)).toHaveLength(0);
    expect(await links.isLinkBlocked(donna.id, ray.id)).toBe(true);

    // The other direction reads as MY block.
    await expect(message(ray, "Donna")).rejects.toThrow(
      "Your workspace owner has blocked messaging Donna",
    );
  });

  it('"approve + always allow" sets the DECIDER\'s side only', async () => {
    const { donna, ray } = await seedPair();
    await message(donna, "Ray");
    const [mine] = await holdsFor(donna.id);
    await approve(mine!.id, "approve_always");

    const peersOfDonna = await links.listPeers({
      workspaceId: WORKSPACE,
      agentId: donna.id,
    });
    const ray_ = peersOfDonna.find((p) => p.agentId === ray.id);
    expect(ray_?.myPolicy).toBe("allow");
    expect(ray_?.theirPolicy).toBe("ask");

    const peersOfRay = await links.listPeers({
      workspaceId: WORKSPACE,
      agentId: ray.id,
    });
    const donna_ = peersOfRay.find((p) => p.agentId === donna.id);
    expect(donna_?.myPolicy).toBe("ask");
    expect(donna_?.theirPolicy).toBe("allow");
  });

  it("verify at replay: a block landing AFTER the cards refuses the approve, no turn", async () => {
    const { donna, ray } = await seedPair();
    await message(donna, "Ray");
    const [mine] = await holdsFor(donna.id);
    const [theirs] = await holdsFor(ray.id);
    await approve(mine!.id);
    await links.setLinkPolicy({
      workspaceId: WORKSPACE,
      agentId: ray.id,
      peerAgentId: donna.id,
      policy: "blocked",
      deciderUserId: OWNER,
    });
    const result = await approve(theirs!.id);
    expect(result.kind).toBe("decided");
    if (result.kind !== "decided") throw new Error("unreachable");
    expect(result.status).toBe("failed");
    expect(await turnsOf(ray.id)).toHaveLength(0);
  });
});

// ── The fence ───────────────────────────────────────────────────────────────

describe.skipIf(!PROOF_URL)("agent links (5b) — the fence", () => {
  it("a name resolves inside the sender's workspace only; an id reaches anywhere; never the sender itself", async () => {
    const donna = await seedAgent("Donna");
    const farRay = await seedAgent("Ray", OTHER_WORKSPACE);

    await expect(message(donna, "Ray")).rejects.toThrow(
      'No agent named "Ray", and there are no other agents in your workspace.',
    );
    await expect(message(donna, "Donna")).rejects.toThrow(/No agent named/);

    const byId = await message(donna, farRay.id, "cross-workspace hello");
    expect(byId.kind).toBe("held");
    expect(await holdsFor(farRay.id)).toHaveLength(1);
  });

  it("the unknown-name error names the roster, so the model can correct itself", async () => {
    const donna = await seedAgent("Donna");
    await seedAgent("Ray");
    await seedAgent("Zoe");
    await expect(message(donna, "Rey")).rejects.toThrow(
      'No agent named "Rey". Agents you can message: Ray, Zoe.',
    );
  });

  it("a foreign workspace cannot set a link policy for an agent it does not own; an agent cannot link itself", async () => {
    const { donna, ray } = await seedPair();
    expect(
      await links.setLinkPolicy({
        workspaceId: OTHER_WORKSPACE,
        agentId: donna.id,
        peerAgentId: ray.id,
        policy: "allow",
        deciderUserId: OWNER,
      }),
    ).toBeNull();
    expect(
      await links.setLinkPolicy({
        workspaceId: WORKSPACE,
        agentId: donna.id,
        peerAgentId: donna.id,
        policy: "allow",
        deciderUserId: OWNER,
      }),
    ).toBeNull();
    expect(await db.agentLink.count()).toBe(0);
    // And a foreign workspace reads an empty roster.
    expect(
      await links.listPeers({
        workspaceId: OTHER_WORKSPACE,
        agentId: donna.id,
      }),
    ).toEqual([]);
  });

  it("a bare foreign agent id is NOT_FOUND from the dashboard (existence is not ownership); once the pair has met, the policy can be set", async () => {
    const donna = await seedAgent("Donna");
    const farZoe = await seedAgent("Zoe", OTHER_WORKSPACE);
    // The planted negative control: the foreign agent EXISTS, and the
    // answer is still null - indistinguishable from a made-up id.
    expect(
      await links.setLinkPolicy({
        workspaceId: WORKSPACE,
        agentId: donna.id,
        peerAgentId: farZoe.id,
        policy: "blocked",
        deciderUserId: OWNER,
      }),
    ).toEqual(
      await links.setLinkPolicy({
        workspaceId: WORKSPACE,
        agentId: donna.id,
        peerAgentId: "no-such-agent",
        policy: "blocked",
        deciderUserId: OWNER,
      }),
    );
    expect(await db.agentLink.count()).toBe(0);
    // The tool door is where a foreign peer is first reached (by id).
    await message(donna, farZoe.id, "hi from afar");
    expect(await db.agentLink.count()).toBe(1);
    // Now the pair has a row, and the dashboard may govern this side.
    expect(
      await links.setLinkPolicy({
        workspaceId: WORKSPACE,
        agentId: donna.id,
        peerAgentId: farZoe.id,
        policy: "blocked",
        deciderUserId: OWNER,
      }),
    ).toMatchObject({ policy: "blocked" });
  });

  it("forgetLink: clears THIS side only (pair row, own conversation, own pending cards expired); the peer keeps its conversation; fenced; then ask/ask again", async () => {
    const { donna, ray } = await seedPair();
    // Talk both ways so both sides hold a conversation, then open a fresh
    // pending ask so there is a card to expire.
    for (const [a, b] of [
      [donna, ray],
      [ray, donna],
    ] as const) {
      await links.setLinkPolicy({
        workspaceId: WORKSPACE,
        agentId: a.id,
        peerAgentId: b.id,
        policy: "allow",
        deciderUserId: OWNER,
      });
    }
    await message(donna, "Ray", "hi");
    await message(ray, "Donna", "hello back");
    await links.setLinkPolicy({
      workspaceId: WORKSPACE,
      agentId: ray.id,
      peerAgentId: donna.id,
      policy: "ask",
      deciderUserId: OWNER,
    });
    await message(donna, "Ray", "one more"); // holds on Ray only (Donna allows)
    expect(await holdsFor(ray.id)).toHaveLength(1);
    expect(await pairConversationOf(donna.id, ray.id)).not.toBeNull();
    expect(await pairConversationOf(ray.id, donna.id)).not.toBeNull();

    // A foreign workspace cannot forget Ray's side.
    expect(
      await links.forgetLink({
        workspaceId: OTHER_WORKSPACE,
        agentId: ray.id,
        peerAgentId: donna.id,
      }),
    ).toBe(false);

    expect(
      await links.forgetLink({
        workspaceId: WORKSPACE,
        agentId: ray.id,
        peerAgentId: donna.id,
      }),
    ).toBe(true);
    // Ray's side: conversation gone, card expired.
    expect(await pairConversationOf(ray.id, donna.id)).toBeNull();
    expect((await holdsFor(ray.id)).map((h) => h.status)).toEqual(["expired"]);
    // Donna's side untouched: her transcript is her owners' record.
    expect(await pairConversationOf(donna.id, ray.id)).not.toBeNull();
    // The pair row is gone: the roster shows Ray at ask/ask again.
    expect(await db.agentLink.count()).toBe(0);
    const rayView = await links.listPeers({
      workspaceId: WORKSPACE,
      agentId: ray.id,
    });
    expect(rayView.find((p) => p.agentId === donna.id)).toMatchObject({
      myPolicy: "ask",
      theirPolicy: "ask",
      conversationId: null,
      paused: false,
    });
    // Nothing left to forget: not-found-shaped.
    expect(
      await links.forgetLink({
        workspaceId: WORKSPACE,
        agentId: ray.id,
        peerAgentId: donna.id,
      }),
    ).toBe(false);
  });

  it("listPeers: the workspace's other agents (pristine) plus linked peers from elsewhere, with the pair conversation once they talked", async () => {
    const { donna, ray } = await seedPair();
    const farZoe = await seedAgent("Zoe", OTHER_WORKSPACE);
    // The far pair meets through the tool door, then Donna's side allows.
    await message(donna, farZoe.id, "hello");
    await links.setLinkPolicy({
      workspaceId: WORKSPACE,
      agentId: donna.id,
      peerAgentId: farZoe.id,
      policy: "allow",
      deciderUserId: OWNER,
    });
    // Ray talks to Donna (both allow), so Donna's side has a conversation.
    await links.setLinkPolicy({
      workspaceId: WORKSPACE,
      agentId: donna.id,
      peerAgentId: ray.id,
      policy: "allow",
      deciderUserId: OWNER,
    });
    await links.setLinkPolicy({
      workspaceId: WORKSPACE,
      agentId: ray.id,
      peerAgentId: donna.id,
      policy: "allow",
      deciderUserId: OWNER,
    });
    await message(ray, "Donna", "hey");

    const peers = await links.listPeers({
      workspaceId: WORKSPACE,
      agentId: donna.id,
    });
    expect(peers.map((p) => p.name).sort()).toEqual(["Ray", "Zoe"]);
    const rayRow = peers.find((p) => p.agentId === ray.id)!;
    expect(rayRow.workspaceName).toBeNull();
    expect(rayRow.myPolicy).toBe("allow");
    expect(rayRow.conversationId).toBe(
      (await pairConversationOf(donna.id, ray.id))?.id,
    );
    const zoeRow = peers.find((p) => p.agentId === farZoe.id)!;
    expect(zoeRow.workspaceName).toBe("A2A Other");
    expect(zoeRow.myPolicy).toBe("allow");
    expect(zoeRow.theirPolicy).toBe("ask");
    expect(zoeRow.conversationId).toBeNull();
  });

  it("the peer context line: a pair conversation's turn says who is on the other end and how to answer; any other conversation says nothing", async () => {
    const { donna, ray } = await seedPair();
    for (const [a, b] of [
      [donna, ray],
      [ray, donna],
    ] as const) {
      await links.setLinkPolicy({
        workspaceId: WORKSPACE,
        agentId: a.id,
        peerAgentId: b.id,
        policy: "allow",
        deciderUserId: OWNER,
      });
    }
    await message(donna, "Ray", "hi");
    const inbox = await pairConversationOf(ray.id, donna.id);
    const line = await roster.buildPeerContext(inbox!.id);
    expect(line).toContain("This is your conversation with Donna");
    expect(line).toContain('prefixed "Donna (agent):"');
    expect(line).toContain('message_agent with to: "Donna"');
    // Not a pair conversation: silence.
    const web = await db.conversation.create({
      data: { agentId: ray.id, source: "web", title: "web" },
      select: { id: true },
    });
    expect(await roster.buildPeerContext(web.id)).toBeNull();
  });

  it("the roster the doc renders: same-workspace peers by name, capped, never the agent itself", async () => {
    const { donna } = await seedPair();
    await seedAgent("Zoe", OTHER_WORKSPACE);
    const rendered = await roster.peersForRender(donna.id);
    expect(rendered).toEqual([{ name: "Ray" }]);
  });
});

// ── Peer tasks ──────────────────────────────────────────────────────────────

describe.skipIf(!PROOF_URL)("agent links — peer tasks", () => {
  const allowBoth = async (a: { id: string }, b: { id: string }) => {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      await links.setLinkPolicy({
        workspaceId: WORKSPACE,
        agentId: x.id,
        peerAgentId: y.id,
        policy: "allow",
        deciderUserId: OWNER,
      });
    }
  };
  /** A person's turn RUNNING in `conversationId` on `agent`. */
  const runningHumanTurn = (
    conversationId: string,
    message: string,
    userId: string = OWNER,
  ) =>
    db.turn.create({
      data: {
        conversationId,
        message,
        status: "running",
        source: "web",
        userId,
      },
      select: { id: true },
    });
  const turnsIn = (conversationId: string) =>
    db.turn.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        message: true,
        source: true,
        userId: true,
        status: true,
      },
    });
  const textOf = async (turnId: string) => {
    const event = await db.turnEvent.findFirst({
      where: { turnId, type: "text" },
      select: { payload: true },
    });
    return (event?.payload as { text?: string } | null)?.text ?? null;
  };
  const tasksOn = (a: { id: string }, b: { id: string }) =>
    db.peerTask.findMany({
      where: tasks.peerTaskPair(a.id, b.id),
      orderBy: { createdAt: "asc" },
    });
  const homeFor = async (agent: { id: string }) => {
    const conversations = await import("../conversation-service");
    return conversations.ensureDirectConversation(WORKSPACE, agent.id, OWNER);
  };
  /** Donna asked by a person in her direct chat; she relays to Ray. */
  const openTask = async (
    donna: { id: string },
    ask = "ask Ray if he can ship by Friday",
    opener = "Can you ship by Friday?",
  ) => {
    const home = await homeFor(donna);
    // One active turn per conversation: an earlier ask still "running" in
    // this rig finishes first, as it would have live.
    await db.turn.updateMany({
      where: { conversationId: home.id, status: "running" },
      data: { status: "done" },
    });
    const turn = await runningHumanTurn(home.id, ask);
    const outcome = await links.requestCommunicate({
      fromAgentId: donna.id,
      to: "Ray",
      text: opener,
      originConversationId: home.id,
      originTurnId: turn.id,
    });
    return { home, turn, outcome };
  };
  const complete = (
    agent: { id: string },
    report: string,
    originConversationId: string | null,
    peer: string | null = null,
  ) =>
    links.completeTask({
      agentId: agent.id,
      report,
      originConversationId,
      peer,
    });

  it("a person's ask OPENS a task: the ask is the person's own words, the home is theirs, the opener spends one message, the pair streaks reset, and the tool result says so", async () => {
    const { donna, ray } = await seedPair();
    await allowBoth(donna, ray);
    // Ray's side mid-chain: a person in the loop resets it.
    await message(donna, "Ray", "warm-up");
    const rayInbox = (await pairConversationOf(ray.id, donna.id))!;
    await db.conversation.update({
      where: { id: rayInbox.id },
      data: { appTurnStreak: 4 },
    });

    const { home, outcome } = await openTask(donna);
    expect(outcome).toEqual({ kind: "sent", to: "Ray", task: "opened" });
    const [task] = await tasksOn(donna, ray);
    expect(task).toMatchObject({
      agentId: donna.id,
      peerAgentId: ray.id,
      homeConversationId: home.id,
      createdByUserId: OWNER,
      ask: "ask Ray if he can ship by Friday",
      opener: "Can you ship by Friday?",
      status: "open",
      agentSent: 1,
      peerSent: 0,
      awaitingPeer: true,
    });
    expect(task!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    // Delivered to Ray's pair conversation; nothing lands at home.
    expect((await turnsOf(ray.id)).at(-1)?.message).toBe(
      "Donna (agent): Can you ship by Friday?",
    );
    expect((await turnsIn(home.id)).map((t) => t.message)).toEqual([
      "ask Ray if he can ship by Friday",
    ]);
    // A task-metered pair is not cap-metered: the streak reset and stayed.
    expect((await pairConversationOf(ray.id, donna.id))?.appTurnStreak).toBe(0);
    // The sender's record carries the opensTask mark.
    const record = (await turnsOf(donna.id)).at(-1)!;
    const stamp = await db.turnEvent.findFirst({
      where: { turnId: record.id, type: "notice" },
      select: { payload: true },
    });
    expect((stamp?.payload as { peerMessage?: unknown }).peerMessage).toEqual({
      to: ray.id,
      text: "Can you ship by Friday?",
      opensTask: true,
    });
  });

  it("the exchange stays on the pair conversations: the peer's reply wakes the OWNER'S PAIR THREAD only, spends the peer's budget, and is remembered as the last reply; the home hears nothing until the report", async () => {
    const { donna, ray } = await seedPair();
    await allowBoth(donna, ray);
    const { home } = await openTask(donna);

    expect(await message(ray, "Donna", "Yes, the API part by Friday.")).toEqual(
      { kind: "sent", to: "Donna", task: "ongoing" },
    );
    const donnaPair = (await pairConversationOf(donna.id, ray.id))!;
    const onPair = await turnsIn(donnaPair.id);
    expect(onPair.at(-1)).toMatchObject({
      message: "Donna (agent): Yes, the API part by Friday.".replace(
        "Donna (agent)",
        "Ray (agent)",
      ),
      source: "agent",
      userId: null,
      status: "queued",
    });
    // NOT at home: one wake, on the pair thread.
    expect((await turnsIn(home.id)).map((t) => t.source)).toEqual(["web"]);
    const [task] = await tasksOn(donna, ray);
    expect(task).toMatchObject({
      agentSent: 1,
      peerSent: 1,
      awaitingPeer: false,
      lastPeerText: "Yes, the API part by Friday.",
    });

    // The context blocks: the owner's pair turn hears the person's ask and
    // the budget; the peer's pair turn hears a person is behind it (never
    // the words); the home hears a task is open for it.
    const ownerLine = await roster.buildPeerContext(donnaPair.id);
    expect(ownerLine).toContain("This is your conversation with Ray");
    expect(ownerLine).toContain(
      "They asked you, in another conversation: “ask Ray if he can ship by Friday”",
    );
    expect(ownerLine).toContain(
      "You can send 5 more messages; Ray can reply 5 more times",
    );
    expect(ownerLine).toContain("call complete_task");
    const rayPair = (await pairConversationOf(ray.id, donna.id))!;
    const peerLine = await roster.buildPeerContext(rayPair.id);
    expect(peerLine).toContain("Donna is asking on behalf of a person");
    expect(peerLine).toContain("You can reply 5 more times");
    expect(peerLine).not.toContain("ship by Friday");
    const homeLine = await roster.buildPeerContext(home.id);
    expect(homeLine).toContain("You have a task open with Ray");
    expect(homeLine).toContain("“ask Ray if he can ship by Friday”");
    expect(homeLine).toContain("lands here on its own");
  });

  it("complete_task from the pair conversation: the report lands in the home as a born-done peer_task turn under the caption, the pair records the close, the task is immutable, and a second call refuses", async () => {
    const { donna, ray } = await seedPair();
    await allowBoth(donna, ray);
    const { home } = await openTask(donna);
    await message(ray, "Donna", "Yes, by Friday.");
    const donnaPair = (await pairConversationOf(donna.id, ray.id))!;

    expect(
      await complete(
        donna,
        "Ray says yes, the API part ships Friday.",
        donnaPair.id,
      ),
    ).toEqual({ peerName: "Ray" });

    const atHome = await turnsIn(home.id);
    expect(atHome).toHaveLength(2);
    expect(atHome[1]).toMatchObject({
      message: "After talking with Ray",
      source: "peer_task",
      userId: null,
      status: "done",
    });
    expect(await textOf(atHome[1]!.id)).toBe(
      "Ray says yes, the API part ships Friday.",
    );
    const [task] = await tasksOn(donna, ray);
    expect(task).toMatchObject({ status: "done", outcome: "reported" });
    expect(task!.closedAt).not.toBeNull();
    // The pair record: a born-done notice stamped peerTask.
    const record = (await turnsIn(donnaPair.id)).at(-1)!;
    expect(record).toMatchObject({ message: "", status: "done" });
    const stamp = await db.turnEvent.findFirst({
      where: { turnId: record.id, type: "notice" },
      select: { payload: true },
    });
    expect(stamp?.payload).toMatchObject({
      text: "Reported back to the person.",
      peerTask: { outcome: "reported" },
    });
    // The home's standing line is gone; the pair context is the plain one.
    expect(await roster.buildPeerContext(home.id)).toBeNull();
    expect(await roster.buildPeerContext(donnaPair.id)).not.toContain(
      "complete_task",
    );
    // Immutable: a second report refuses, and nothing more lands.
    await expect(complete(donna, "again", donnaPair.id)).rejects.toThrow(
      /already closed|no open task/,
    );
    expect(await turnsIn(home.id)).toHaveLength(2);
    // The continuity bridge relays the report WHOLE into the next human turn.
    const turnService = await import("../turn-service");
    const bridge = await turnService.buildContinuityBridge(
      home.id,
      new Date(Date.now() + 1000),
    );
    expect(bridge).toContain("After talking with Ray");
    expect(bridge).toContain("Ray says yes, the API part ships Friday.");
    expect(bridge).toContain("your own report to this person");
  });

  it("the close is claimed EXACTLY ONCE: two concurrent completes post one report; a task-metered pair never touches the cap streak", async () => {
    const { donna, ray } = await seedPair();
    await allowBoth(donna, ray);
    const { home } = await openTask(donna);
    await message(ray, "Donna", "yes");
    await message(donna, "Ray", "and the UI?");
    await message(ray, "Donna", "UI too");
    // Four messages on the pair, none counted by the cap: the task budget
    // meters an open task, and a pair that leaves a task starts at 0.
    expect((await pairConversationOf(ray.id, donna.id))?.appTurnStreak).toBe(0);
    expect((await pairConversationOf(donna.id, ray.id))?.appTurnStreak).toBe(0);
    const donnaPair = (await pairConversationOf(donna.id, ray.id))!;
    const results = await Promise.allSettled([
      complete(donna, "report A", donnaPair.id),
      complete(donna, "report B", donnaPair.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(
      (await turnsIn(home.id)).filter((t) => t.source === "peer_task"),
    ).toHaveLength(1);
    // And a straight second call after the fact is refused too, posting
    // nothing more.
    await expect(complete(donna, "report C", donnaPair.id)).rejects.toThrow();
    expect(
      (await turnsIn(home.id)).filter((t) => t.source === "peer_task"),
    ).toHaveLength(1);
  });

  it("complete_task is fenced: the PEER cannot complete the owner's task; with no origin the owner's one open task is taken, several need `peer`, none refuses", async () => {
    const { donna, ray } = await seedPair();
    const zoe = await seedAgent("Zoe");
    await allowBoth(donna, ray);
    await allowBoth(donna, zoe);
    await openTask(donna);
    const rayPair = (await pairConversationOf(ray.id, donna.id))!;
    await expect(complete(ray, "I finished it", rayPair.id)).rejects.toThrow(
      /theirs to complete/,
    );
    // No origin, one task: taken.
    const home = await homeFor(donna);
    // A second task for Zoe from the same person's next question.
    await db.turn.updateMany({
      where: { conversationId: home.id },
      data: { status: "done" },
    });
    const turn2 = await runningHumanTurn(home.id, "and ask Zoe about the UI");
    expect(
      await links.requestCommunicate({
        fromAgentId: donna.id,
        to: "Zoe",
        text: "UI by Friday?",
        originConversationId: home.id,
        originTurnId: turn2.id,
      }),
    ).toEqual({ kind: "sent", to: "Zoe", task: "opened" });
    await expect(complete(donna, "which one?", null)).rejects.toThrow(
      /open tasks with Ray and Zoe/,
    );
    // Named but wrong: a refusal, never "the other one".
    await expect(complete(donna, "hm", null, "Nobody")).rejects.toThrow(
      /no open task with Nobody/,
    );
    expect(await complete(donna, "Zoe says yes", null, "zoe")).toEqual({
      peerName: "Zoe",
    });
    expect(await complete(donna, "Ray says yes", null)).toEqual({
      peerName: "Ray",
    });
    await expect(complete(donna, "nothing left", null)).rejects.toThrow(
      /no open task to report on/,
    );
    // Both reports reached the home, in order.
    const atHome = await turnsIn(home.id);
    expect(atHome.filter((t) => t.source === "peer_task")).toHaveLength(2);
  });

  it("the budget: one conditional write per message; the owner cannot send once a side is spent (told to report), the peer is told to stop; nothing is refused with 'try again'", async () => {
    const { donna, ray } = await seedPair();
    await allowBoth(donna, ray);
    await openTask(donna); // agentSent 1
    const rayPair = (await pairConversationOf(ray.id, donna.id))!;
    for (let i = 1; i < tasks.PEER_TASK_MESSAGE_BUDGET; i += 1) {
      await message(ray, "Donna", `reply ${i}`);
      await message(donna, "Ray", `question ${i + 1}`);
    }
    // Donna: 6 sent, Ray: 5. Ray may reply once more.
    expect((await tasksOn(donna, ray))[0]).toMatchObject({
      agentSent: 6,
      peerSent: 5,
    });
    await expect(message(donna, "Ray", "one more")).rejects.toThrow(
      /You have no messages left in this task\. Call complete_task now/,
    );
    expect(await message(ray, "Donna", "reply 6")).toMatchObject({
      kind: "sent",
    });
    await expect(message(ray, "Donna", "reply 7")).rejects.toThrow(
      /You have no replies left in this task\. Don't retry/,
    );
    // The counters never passed the cap; refusals cost nothing.
    expect((await tasksOn(donna, ray))[0]).toMatchObject({
      agentSent: 6,
      peerSent: 6,
      status: "open",
    });
    // Refused turns did not land anywhere.
    expect(
      (await turnsIn(rayPair.id)).filter((t) => t.message.includes("one more")),
    ).toHaveLength(0);
  });

  it("the owner's budget guard also reads the PEER's count: a question the peer could never answer is refused with the reason", async () => {
    const { donna, ray } = await seedPair();
    await allowBoth(donna, ray);
    await openTask(donna);
    const [task] = await tasksOn(donna, ray);
    await db.peerTask.update({
      where: { id: task!.id },
      data: { peerSent: tasks.PEER_TASK_MESSAGE_BUDGET, awaitingPeer: false },
    });
    await expect(message(donna, "Ray", "and one more thing")).rejects.toThrow(
      /Ray has no replies left in this task/,
    );
  });

  it("the budget backstop: the owner's pair turn closes with a side spent, nothing in flight, no report -> the task ends `budget` and the home gets the line with the peer's last message", async () => {
    const { donna, ray } = await seedPair();
    await allowBoth(donna, ray);
    const { home } = await openTask(donna);
    const [task] = await tasksOn(donna, ray);
    await db.peerTask.update({
      where: { id: task!.id },
      data: {
        agentSent: tasks.PEER_TASK_MESSAGE_BUDGET,
        peerSent: 3,
        awaitingPeer: false,
        lastPeerText: "Friday is fine but not the UI.",
      },
    });
    const donnaPair = (await pairConversationOf(donna.id, ray.id))!;
    // In flight (awaitingPeer) -> no close, even when spent.
    await db.peerTask.update({
      where: { id: task!.id },
      data: { awaitingPeer: true },
    });
    await links.settlePairTurn({ agentId: donna.id, externalRef: ray.id });
    expect((await tasksOn(donna, ray))[0]?.status).toBe("open");
    // The peer answered; the owner's turn closes with nothing asked or
    // reported.
    await db.peerTask.update({
      where: { id: task!.id },
      data: { awaitingPeer: false },
    });
    // The PEER's turn close never settles the owner's task.
    await links.settlePairTurn({ agentId: ray.id, externalRef: donna.id });
    expect((await tasksOn(donna, ray))[0]?.status).toBe("open");
    await links.settlePairTurn({ agentId: donna.id, externalRef: ray.id });
    const closed = (await tasksOn(donna, ray))[0]!;
    expect(closed).toMatchObject({ status: "done", outcome: "budget" });
    const line = await textOf((await turnsIn(home.id)).at(-1)!.id);
    expect(line).toContain(
      "Donna used up its messages with Ray before reporting back.",
    );
    expect(line).toContain(
      "Ray’s last message: “Friday is fine but not the UI.”",
    );
    expect((await turnsIn(home.id)).at(-1)).toMatchObject({
      message: "After talking with Ray",
      source: "peer_task",
    });
    // Idempotent: a second settle finds nothing.
    await links.settlePairTurn({ agentId: donna.id, externalRef: ray.id });
    expect(
      (await turnsIn(home.id)).filter((t) => t.source === "peer_task"),
    ).toHaveLength(1);
    // Under budget with nothing in flight: left alone (the idle clock is the
    // backstop for a forgetful model).
    const { home: home2 } = await openTask(donna, "second ask", "second?");
    await db.peerTask.updateMany({
      where: { status: "open", agentId: donna.id },
      data: { awaitingPeer: false, peerSent: 1 },
    });
    await links.settlePairTurn({ agentId: donna.id, externalRef: ray.id });
    expect(
      (await tasksOn(donna, ray)).filter((t) => t.status === "open"),
    ).toHaveLength(1);
    expect(
      (await turnsIn(home2.id)).filter((t) => t.source === "peer_task"),
    ).toHaveLength(1); // still just the first task's line (same home)
    void donnaPair;
  });

  it("finishTurn on the owner's pair turn drives the budget backstop through the REAL settle door (the runner's close report)", async () => {
    // The hook lives in turn-service's settle dispatch, beside the cron and
    // watch arms: this is the door the runner's terminal report takes, so
    // a wiring slip there would leave every spent task open forever.
    // MUTATION-PROOF: drop the `source === "agent"` arm from
    // settleAutomationRun and this fails.
    const { donna, ray } = await seedPair();
    await allowBoth(donna, ray);
    const { home } = await openTask(donna);
    await message(ray, "Donna", "final word");
    const [task] = await tasksOn(donna, ray);
    await db.peerTask.update({
      where: { id: task!.id },
      data: { agentSent: tasks.PEER_TASK_MESSAGE_BUDGET, awaitingPeer: false },
    });
    const RUNNER = `${P}runner-settle`;
    await db.runner.create({
      data: { id: RUNNER, name: "runner", token: `rnr_${P}settle` },
    });
    await db.sandbox.create({
      data: {
        id: `${P}sb-settle`,
        agentId: donna.id,
        runnerId: RUNNER,
        status: "running",
      },
    });
    const donnaPair = (await pairConversationOf(donna.id, ray.id))!;
    // The turn Ray's last word created on Donna's pair thread, running.
    const turn = await db.turn.findFirstOrThrow({
      where: { conversationId: donnaPair.id, message: { startsWith: "Ray" } },
      select: { id: true },
    });
    await db.turn.update({
      where: { id: turn.id },
      data: { status: "running", startedAt: new Date() },
    });
    const turnService = await import("../turn-service");
    await turnService.finishTurn({
      reporter: { sandboxId: `${P}sb-settle`, runnerId: RUNNER },
      conversationId: donnaPair.id,
      turnId: turn.id,
      status: "done",
    });
    expect((await tasksOn(donna, ray))[0]).toMatchObject({
      status: "done",
      outcome: "budget",
    });
    expect((await turnsIn(home.id)).at(-1)).toMatchObject({
      source: "peer_task",
      message: "After talking with Ray",
    });
  });

  it("the idle clock: the sweep closes an open task past its deadline (`expired`, the line says so), leaves a fresh one, and a spend refreshes the clock", async () => {
    const { donna, ray } = await seedPair();
    await allowBoth(donna, ray);
    const { home } = await openTask(donna);
    const [task] = await tasksOn(donna, ray);
    const before = task!.expiresAt!.getTime();
    await new Promise((r) => setTimeout(r, 5));
    await message(ray, "Donna", "working on it");
    expect(
      (await tasksOn(donna, ray))[0]!.expiresAt!.getTime(),
    ).toBeGreaterThan(before);
    // Not due: the sweep leaves it.
    await links.sweepPeerTasks();
    expect((await tasksOn(donna, ray))[0]?.status).toBe("open");
    // Past due: closed, with the peer's last words.
    await db.peerTask.update({
      where: { id: task!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await links.sweepPeerTasks();
    expect((await tasksOn(donna, ray))[0]).toMatchObject({
      status: "done",
      outcome: "expired",
    });
    const line = await textOf((await turnsIn(home.id)).at(-1)!.id);
    expect(line).toContain(
      "did not report back after 30 minutes without progress",
    );
    expect(line).toContain("Ray’s last message: “working on it”");
  });

  it("one open task per pair: a second person's ask QUEUES (frozen opener, not delivered), a fourth is refused, and the close of the open task starts the next in order", async () => {
    const { donna, ray } = await seedPair();
    await allowBoth(donna, ray);
    const { home: home1 } = await openTask(donna, "first ask", "first?");
    // Three more people (the same owner in three other conversations is the
    // simplest stand-in: each ask has its own home).
    const others: string[] = [];
    for (const n of [2, 3, 4]) {
      const conversations = await import("../conversation-service");
      const room = await conversations.ensureSourcedConversation(
        WORKSPACE,
        donna.id,
        { source: "slack", externalRef: `${P}room-${n}` },
      );
      const turn = await runningHumanTurn(room.id, `ask ${n}`);
      const outcome = await links.requestCommunicate({
        fromAgentId: donna.id,
        to: "Ray",
        text: `question ${n}?`,
        originConversationId: room.id,
        originTurnId: turn.id,
      });
      expect(outcome).toEqual({ kind: "sent", to: "Ray", task: "queued" });
      others.push(room.id);
    }
    expect(
      (await tasksOn(donna, ray)).map((t) => [t.status, t.opener]),
    ).toEqual([
      ["open", "first?"],
      ["queued", "question 2?"],
      ["queued", "question 3?"],
      ["queued", "question 4?"],
    ]);
    // Only the first opener reached Ray.
    expect((await turnsOf(ray.id)).map((t) => t.message)).toEqual([
      "Donna (agent): first?",
    ]);
    // The fifth ask: queue full, refused to the model in plain words.
    const conversations = await import("../conversation-service");
    const room5 = await conversations.ensureSourcedConversation(
      WORKSPACE,
      donna.id,
      { source: "slack", externalRef: `${P}room-5` },
    );
    const turn5 = await runningHumanTurn(room5.id, "ask 5");
    await expect(
      links.requestCommunicate({
        fromAgentId: donna.id,
        to: "Ray",
        text: "question 5?",
        originConversationId: room5.id,
        originTurnId: turn5.id,
      }),
    ).rejects.toThrow(/busy with another task and 3 more are already waiting/);
    // The same home adding to its own QUEUED task extends its opener (no
    // second queue entry), so the peer hears the whole question at start.
    await db.turn.updateMany({
      where: { conversationId: others[0]! },
      data: { status: "done" },
    });
    const more2 = await runningHumanTurn(others[0]!, "and one more thing");
    expect(
      await links.requestCommunicate({
        fromAgentId: donna.id,
        to: "Ray",
        text: "also, when?",
        originConversationId: others[0]!,
        originTurnId: more2.id,
      }),
    ).toEqual({ kind: "sent", to: "Ray", task: "queued" });
    expect(await tasksOn(donna, ray)).toHaveLength(4);
    expect((await tasksOn(donna, ray))[1]?.opener).toBe(
      "question 2?\n\nalso, when?",
    );

    // The same home adding to its own open task JOINS it (no queue entry).
    const donnaPair = (await pairConversationOf(donna.id, ray.id))!;
    await db.turn.updateMany({
      where: { conversationId: home1.id },
      data: { status: "done" },
    });
    const more = await runningHumanTurn(home1.id, "also ask about the API");
    expect(
      await links.requestCommunicate({
        fromAgentId: donna.id,
        to: "Ray",
        text: "and the API?",
        originConversationId: home1.id,
        originTurnId: more.id,
      }),
    ).toEqual({ kind: "sent", to: "Ray", task: "joined" });
    expect((await tasksOn(donna, ray))[0]).toMatchObject({
      status: "open",
      agentSent: 2,
    });
    expect(await tasksOn(donna, ray)).toHaveLength(4);

    // Close the open task: the oldest queued one starts, its opener lands.
    await complete(donna, "first done", donnaPair.id);
    expect(
      (await tasksOn(donna, ray)).map((t) => [t.status, t.opener]),
    ).toEqual([
      ["done", "first?"],
      ["open", "question 2?\n\nalso, when?"],
      ["queued", "question 3?"],
      ["queued", "question 4?"],
    ]);
    expect((await turnsOf(ray.id)).map((t) => t.message)).toEqual([
      "Donna (agent): first?",
      "Donna (agent): and the API?",
      "Donna (agent): question 2?\n\nalso, when?",
    ]);
    // The promoted task's report goes to ITS home, not the first one's.
    await complete(donna, "second done", donnaPair.id);
    expect(
      (await turnsIn(others[0]!)).filter((t) => t.source === "peer_task"),
    ).toHaveLength(1);
    expect(
      (await turnsIn(home1.id)).filter((t) => t.source === "peer_task"),
    ).toHaveLength(1);
    // The sweep's promotion arm is the recovery path: a queued task whose
    // pair is free starts on the next pass.
    await db.peerTask.updateMany({
      where: { status: "open" },
      data: { status: "done", outcome: "reported" },
    });
    await links.sweepPeerTasks();
    expect((await tasksOn(donna, ray)).map((t) => t.status)).toEqual([
      "done",
      "done",
      "done",
      "open",
    ]);
  });

  it("block or remove mid-task closes every task on the pair with the reason at each home; the OTHER side's task closes too on a block", async () => {
    const { donna, ray } = await seedPair();
    await allowBoth(donna, ray);
    const { home: donnaHome } = await openTask(donna);
    // Ray's person opens one too (it queues behind Donna's).
    const rayHome = await homeFor(ray);
    const rayTurn = await runningHumanTurn(rayHome.id, "ask Donna about lunch");
    expect(
      await links.requestCommunicate({
        fromAgentId: ray.id,
        to: "Donna",
        text: "lunch?",
        originConversationId: rayHome.id,
        originTurnId: rayTurn.id,
      }),
    ).toEqual({ kind: "sent", to: "Donna", task: "queued" });

    // Ray's owner blocks: both tasks end, both people hear it.
    await links.setLinkPolicy({
      workspaceId: WORKSPACE,
      agentId: ray.id,
      peerAgentId: donna.id,
      policy: "blocked",
      deciderUserId: OWNER,
    });
    expect((await tasksOn(donna, ray)).map((t) => t.outcome)).toEqual([
      "blocked",
      "blocked",
    ]);
    expect(await textOf((await turnsIn(donnaHome.id)).at(-1)!.id)).toContain(
      "Messaging between Donna and Ray was blocked before Donna could report back.",
    );
    expect(await textOf((await turnsIn(rayHome.id)).at(-1)!.id)).toContain(
      "Messaging between Ray and Donna was blocked",
    );
    // A queued task never started: the line says so instead of quoting.
    expect(await textOf((await turnsIn(rayHome.id)).at(-1)!.id)).toContain(
      "The task never started.",
    );

    // Remove: the same, `removed`.
    await allowBoth(donna, ray);
    const { home: again } = await openTask(donna, "again", "again?");
    await links.forgetLink({
      workspaceId: WORKSPACE,
      agentId: donna.id,
      peerAgentId: ray.id,
    });
    expect((await tasksOn(donna, ray)).at(-1)).toMatchObject({
      outcome: "removed",
    });
    expect(await textOf((await turnsIn(again.id)).at(-1)!.id)).toContain(
      "Ray was removed from Donna’s contacts before Donna could report back.",
    );
  });

  it("held then approved: the task opener frozen into the hold opens the person's task at replay; an agent-driven hold opens none", async () => {
    const { donna, ray } = await seedPair();
    // ask/ask: both cards.
    const { home, outcome } = await openTask(donna);
    expect(outcome).toMatchObject({ kind: "held", to: "Ray" });
    expect(await tasksOn(donna, ray)).toHaveLength(0);
    const [donnaHold] = await holdsFor(donna.id);
    expect(donnaHold!.payload).toMatchObject({
      task: {
        homeConversationId: home.id,
        ask: "ask Ray if he can ship by Friday",
        createdByUserId: OWNER,
      },
    });
    const [rayHold] = await holdsFor(ray.id);
    await approve(donnaHold!.id);
    await approve(rayHold!.id);
    expect((await tasksOn(donna, ray))[0]).toMatchObject({
      status: "open",
      homeConversationId: home.id,
      ask: "ask Ray if he can ship by Friday",
      agentSent: 1,
    });
    expect((await turnsOf(ray.id)).at(-1)?.message).toBe(
      "Donna (agent): Can you ship by Friday?",
    );
    // Ray's reply from the pair thread while both sides still ask: two
    // holds again; approving both delivers it as an agent message ON the
    // task (no second task, the peer's budget spent).
    await message(ray, "Donna", "yes");
    const [, rayHold2] = await holdsFor(ray.id);
    const [, donnaHold2] = await holdsFor(donna.id);
    expect(rayHold2!.payload).not.toHaveProperty("task");
    await approve(rayHold2!.id);
    await approve(donnaHold2!.id);
    expect(await tasksOn(donna, ray)).toHaveLength(1);
    expect((await tasksOn(donna, ray))[0]).toMatchObject({ peerSent: 1 });
  });

  it("a 5b hold (home only, no `task`) approved after the upgrade opens a task with the message as the ask", async () => {
    const { donna, ray } = await seedPair();
    const home = await homeFor(donna);
    const held = await approvals.requestActionApproval({
      agentId: donna.id,
      conversationId: null,
      originTurnId: null,
      action: links.AGENT_COMMUNICATE_ACTION,
      payload: {
        fromAgentId: donna.id,
        toAgentId: ray.id,
        text: "old-style question?",
        homeConversationId: home.id,
      },
      summary: "legacy",
    });
    await links.setLinkPolicy({
      workspaceId: WORKSPACE,
      agentId: ray.id,
      peerAgentId: donna.id,
      policy: "allow",
      deciderUserId: OWNER,
    });
    await approve(held.id);
    expect((await tasksOn(donna, ray))[0]).toMatchObject({
      status: "open",
      homeConversationId: home.id,
      ask: "old-style question?",
      createdByUserId: null,
    });
  });

  it("fences: the person test reads the TURN (running, human-authored, on the sender, not a pair thread); the home is re-checked as the owner's own at report time; a vanished home drops the report quietly", async () => {
    const { donna, ray } = await seedPair();
    await allowBoth(donna, ray);
    const conversations = await import("../conversation-service");
    const home = await homeFor(donna);
    const driven = (text: string, originTurnId: string | null) =>
      links.requestCommunicate({
        fromAgentId: donna.id,
        to: "Ray",
        text,
        originConversationId: home.id,
        originTurnId,
      });
    // (a) no origin; (b) a stale human turn; (c) a running guest turn;
    // (d) a running human turn on ANOTHER agent; (e) a turn on the pair
    // thread. None opens a task.
    expect(await driven("no origin", null)).toMatchObject({ task: "none" });
    const stale = await db.turn.create({
      data: {
        conversationId: home.id,
        message: "yesterday",
        status: "done",
        source: "web",
        userId: OWNER,
      },
      select: { id: true },
    });
    expect(await driven("stale", stale.id)).toMatchObject({ task: "none" });
    const guestRoom = await conversations.ensureSourcedConversation(
      WORKSPACE,
      donna.id,
      { source: "slack", externalRef: `${P}guest` },
    );
    const guest = await db.turn.create({
      data: {
        conversationId: guestRoom.id,
        message: "guest",
        status: "running",
        source: "slack",
        userId: null,
      },
      select: { id: true },
    });
    expect(await driven("guest", guest.id)).toMatchObject({ task: "none" });
    const rayHome = await homeFor(ray);
    const foreign = await runningHumanTurn(rayHome.id, "not donna's");
    expect(await driven("foreign", foreign.id)).toMatchObject({
      task: "none",
    });
    const donnaPair = (await pairConversationOf(donna.id, ray.id))!;
    const chain = await db.turn.findFirstOrThrow({
      where: { conversationId: donnaPair.id },
      select: { id: true },
    });
    expect(await driven("chain", chain.id)).toMatchObject({ task: "none" });
    expect(await tasksOn(donna, ray)).toHaveLength(0);

    // A planted home (Ray's conversation on Donna's task row) is never
    // written to at report time.
    const { home: real } = await openTask(donna);
    const [task] = await tasksOn(donna, ray);
    await db.peerTask.update({
      where: { id: task!.id },
      data: { homeConversationId: rayHome.id },
    });
    await complete(donna, "planted", donnaPair.id);
    expect(
      (await turnsIn(rayHome.id)).filter((t) => t.source === "peer_task"),
    ).toHaveLength(0);
    expect(
      (await turnsIn(real.id)).filter((t) => t.source === "peer_task"),
    ).toHaveLength(0);
    expect((await tasksOn(donna, ray))[0]?.status).toBe("done");

    // A deleted home takes its task with it (cascade): nothing to report.
    const { home: gone } = await openTask(donna, "gone", "gone?");
    await db.conversation.delete({ where: { id: gone.id } });
    expect(
      (await tasksOn(donna, ray)).filter((t) => t.status === "open"),
    ).toHaveLength(0);
  });

  it("the person's ask is cleaned and bounded before it becomes the task's words", async () => {
    const { donna, ray } = await seedPair();
    await allowBoth(donna, ray);
    const home = await homeFor(donna);
    const long = `ask\u0007 Ray   ${"x".repeat(2000)}`;
    const turn = await runningHumanTurn(home.id, long);
    await links.requestCommunicate({
      fromAgentId: donna.id,
      to: "Ray",
      text: "q?",
      originConversationId: home.id,
      originTurnId: turn.id,
    });
    const [task] = await tasksOn(donna, ray);
    expect(task!.ask.startsWith("ask Ray x")).toBe(true);
    expect(task!.ask.length).toBe(tasks.MAX_PEER_TASK_ASK_CHARS);
    expect(task!.ask).not.toContain("\u0007");
  });
});

// ── The cap ─────────────────────────────────────────────────────────────────

describe.skipIf(!PROOF_URL)("agent links (5b) — the cap", () => {
  it("agent turns on the pair conversation cross at the cap: the crossing parks the message in a continue card that names the thread", async () => {
    const { donna, ray } = await seedPair();
    for (const [a, b] of [
      [donna, ray],
      [ray, donna],
    ] as const) {
      await links.setLinkPolicy({
        workspaceId: WORKSPACE,
        agentId: a.id,
        peerAgentId: b.id,
        policy: "allow",
        deciderUserId: OWNER,
      });
    }
    for (let i = 1; i <= cap.APP_TURN_CAP; i += 1) {
      expect(await message(donna, "Ray", `ping ${i}`)).toEqual({
        kind: "sent",
        to: "Ray",
        task: "none",
      });
    }
    expect((await pairConversationOf(ray.id, donna.id))?.appTurnStreak).toBe(
      cap.APP_TURN_CAP,
    );
    // The crossing: refused to the sender, parked for the receiver's owners.
    // A ServiceError, not a bare Error: the tool door relays a ServiceError's
    // words to the model, but turns anything else into "try again" - and a
    // retry into a paused thread is the loop the cap exists to stop.
    await expect(message(donna, "Ray", "ping 7")).rejects.toMatchObject({
      name: "ServiceError",
      message: expect.stringContaining(
        "Ray paused this conversation until a person continues it",
      ),
    });
    const hold = await db.actionApproval.findFirstOrThrow({
      where: { agentId: ray.id, action: cap.APP_TURN_CONTINUE_ACTION },
    });
    expect(hold.summary).toBe('continue the conversation with "Donna"');
    expect(hold.payload).toMatchObject({
      speaker: { kind: "agent", agentId: donna.id },
    });
    expect(await turnsOf(ray.id)).toHaveLength(cap.APP_TURN_CAP);

    // Past the crossing: silence (no second card).
    await expect(message(donna, "Ray", "ping 8")).rejects.toMatchObject({
      name: "ServiceError",
      message: expect.stringContaining("Ray has paused this conversation"),
    });
    expect(
      await db.actionApproval.count({
        where: { agentId: ray.id, action: cap.APP_TURN_CONTINUE_ACTION },
      }),
    ).toBe(1);

    // The pause is VISIBLE on Ray's peer row (and only there: Donna's side
    // is not paused, it is Ray's conversation that crossed). Paused means
    // PAST the crossing: a row sitting exactly at the cap is still open
    // (its next message is the one that crosses and raises the card).
    const rayRow = (
      await links.listPeers({ workspaceId: WORKSPACE, agentId: ray.id })
    ).find((p) => p.agentId === donna.id);
    expect(rayRow?.paused).toBe(true);
    const donnaRow = (
      await links.listPeers({ workspaceId: WORKSPACE, agentId: donna.id })
    ).find((p) => p.agentId === ray.id);
    expect(donnaRow?.paused).toBe(false);
    await db.conversation.update({
      where: { id: (await pairConversationOf(donna.id, ray.id))!.id },
      data: { appTurnStreak: cap.APP_TURN_CAP },
    });
    expect(
      (
        await links.listPeers({ workspaceId: WORKSPACE, agentId: donna.id })
      ).find((p) => p.agentId === ray.id)?.paused,
    ).toBe(false);
    await db.conversation.update({
      where: { id: (await pairConversationOf(donna.id, ray.id))!.id },
      data: { appTurnStreak: 0 },
    });

    // RESUME with the card still pending: it IS the card's approve - the
    // parked message replays, the card settles executed, one more round.
    expect(
      await links.resumePairConversation({
        workspaceId: WORKSPACE,
        agentId: ray.id,
        peerAgentId: donna.id,
        deciderUserId: OWNER,
      }),
    ).toBe(true);
    expect(hold.id).toBeDefined();
    expect(
      (await db.actionApproval.findUniqueOrThrow({ where: { id: hold.id } }))
        .status,
    ).toBe("executed");
    const rayTurns = await turnsOf(ray.id);
    expect(rayTurns.at(-1)?.message).toBe("Donna (agent): ping 7");
    // One more round: the streak is back to 0 (the replay itself is the
    // person's grant, not an agent turn - 5a's contract), not paused.
    expect((await pairConversationOf(ray.id, donna.id))?.appTurnStreak).toBe(0);
    expect(await message(donna, "Ray", "ping 9")).toEqual({
      kind: "sent",
      to: "Ray",
      task: "none",
    });

    // RESUME with NO card (a rejected one): the bare reset, and the next
    // message is admitted - the dead end the dashboard door exists for.
    await db.conversation.update({
      where: { id: (await pairConversationOf(ray.id, donna.id))!.id },
      data: { appTurnStreak: cap.APP_TURN_CAP },
    });
    await expect(message(donna, "Ray", "crossing again")).rejects.toThrow(
      /paused/,
    );
    const second = await db.actionApproval.findFirstOrThrow({
      where: {
        agentId: ray.id,
        action: cap.APP_TURN_CONTINUE_ACTION,
        status: "pending",
      },
    });
    await approve(second.id, "reject");
    expect(
      await links.resumePairConversation({
        workspaceId: WORKSPACE,
        agentId: ray.id,
        peerAgentId: donna.id,
        deciderUserId: OWNER,
      }),
    ).toBe(true);
    expect((await pairConversationOf(ray.id, donna.id))?.appTurnStreak).toBe(0);
    expect(await message(donna, "Ray", "back")).toEqual({
      kind: "sent",
      to: "Ray",
      task: "none",
    });

    // Fenced: a foreign workspace, or a pair that never talked, is not-found.
    expect(
      await links.resumePairConversation({
        workspaceId: OTHER_WORKSPACE,
        agentId: ray.id,
        peerAgentId: donna.id,
        deciderUserId: OWNER,
      }),
    ).toBe(false);
    const zoe = await seedAgent("Zoe");
    expect(
      await links.resumePairConversation({
        workspaceId: WORKSPACE,
        agentId: ray.id,
        peerAgentId: zoe.id,
        deciderUserId: OWNER,
      }),
    ).toBe(false);
  });

  it("a PERSON driving one agent resets the pair's chain on BOTH sides; an unattended or stale origin does not", async () => {
    // The pair reading of "a human is in the loop": the `message_agent`
    // comes from a RUNNING turn a known person authored on the sender (the
    // web chat, a linked Slack user). Then the receiver's pause lifts with
    // no card, and the sender's own side starts fresh too.
    const { donna, ray } = await seedPair();
    for (const [a, b] of [
      [donna, ray],
      [ray, donna],
    ] as const) {
      await links.setLinkPolicy({
        workspaceId: WORKSPACE,
        agentId: a.id,
        peerAgentId: b.id,
        policy: "allow",
        deciderUserId: OWNER,
      });
    }
    // Ray's side paused (past the cap), Donna's side mid-chain.
    await message(donna, "Ray", "opener");
    await message(ray, "Donna", "reply");
    const rayInbox = (await pairConversationOf(ray.id, donna.id))!;
    const donnaInbox = (await pairConversationOf(donna.id, ray.id))!;
    await db.conversation.update({
      where: { id: rayInbox.id },
      data: { appTurnStreak: cap.APP_TURN_CAP + 1 },
    });
    await db.conversation.update({
      where: { id: donnaInbox.id },
      data: { appTurnStreak: 3 },
    });

    // A person talks to Donna in her web chat; the turn is running.
    const conversations = await import("../conversation-service");
    const direct = await conversations.ensureDirectConversation(
      WORKSPACE,
      donna.id,
      OWNER,
    );
    const humanTurn = await db.turn.create({
      data: {
        conversationId: direct.id,
        message: "ask Ray the time",
        status: "running",
        source: "web",
        userId: OWNER,
      },
      select: { id: true },
    });
    // `originConversationId` is provenance for the outcome notices only;
    // the person test reads the TURN (its author, its status, its agent).
    const driven = (text: string, originTurnId: string | null) =>
      links.requestCommunicate({
        fromAgentId: donna.id,
        to: "Ray",
        text,
        originConversationId: direct.id,
        originTurnId,
      });

    // Unattended origins first, while Ray is paused: none of them lift it.
    // (a) no origin at all;
    await expect(driven("no origin", null)).rejects.toThrow(/paused/);
    // (b) a turn on the pair conversation itself (the reply chain);
    const chainTurn = await db.turn.findFirstOrThrow({
      where: { conversationId: donnaInbox.id },
      select: { id: true },
    });
    await expect(driven("from the chain", chainTurn.id)).rejects.toThrow(
      /paused/,
    );
    // (c) a person's turn that is NOT running (an old one the sandbox
    //     could claim forever);
    const oldTurn = await db.turn.create({
      data: {
        conversationId: direct.id,
        message: "yesterday",
        status: "done",
        source: "web",
        userId: OWNER,
      },
      select: { id: true },
    });
    await expect(driven("stale claim", oldTurn.id)).rejects.toThrow(/paused/);
    // (d) a running turn with NO person behind it (a Slack guest, an
    //     automation) - on its own sourced conversation, since a
    //     conversation holds one active turn at a time;
    const guestRoom = await conversations.ensureSourcedConversation(
      WORKSPACE,
      donna.id,
      { source: "slack", externalRef: `${P}guest-room` },
    );
    const guestTurn = await db.turn.create({
      data: {
        conversationId: guestRoom.id,
        message: "guest",
        status: "running",
        source: "slack",
        userId: null,
      },
      select: { id: true },
    });
    await expect(driven("guest claim", guestTurn.id)).rejects.toThrow(/paused/);
    // (e) a running human turn on ANOTHER agent (not the sender's);
    const rayDirect = await conversations.ensureDirectConversation(
      WORKSPACE,
      ray.id,
      OWNER,
    );
    const foreignTurn = await db.turn.create({
      data: {
        conversationId: rayDirect.id,
        message: "not donna's",
        status: "running",
        source: "web",
        userId: OWNER,
      },
      select: { id: true },
    });
    await expect(driven("foreign claim", foreignTurn.id)).rejects.toThrow(
      /paused/,
    );
    expect((await pairConversationOf(ray.id, donna.id))?.appTurnStreak).toBe(
      cap.APP_TURN_CAP + 1,
    );
    expect((await pairConversationOf(donna.id, ray.id))?.appTurnStreak).toBe(3);

    // The person's running turn: both sides reset and a TASK opens; the
    // message lands and is metered by the task budget, not the cap (the
    // streaks stay at 0 while the task runs).
    expect(await driven("what time is it?", humanTurn.id)).toEqual({
      kind: "sent",
      to: "Ray",
      task: "opened",
    });
    expect((await turnsOf(ray.id)).at(-1)?.message).toBe(
      "Donna (agent): what time is it?",
    );
    expect((await pairConversationOf(ray.id, donna.id))?.appTurnStreak).toBe(0);
    expect((await pairConversationOf(donna.id, ray.id))?.appTurnStreak).toBe(0);
    // Ray's answer lands on the task (Donna's side is no longer paused).
    expect(await message(ray, "Donna", "20:42")).toEqual({
      kind: "sent",
      to: "Donna",
      task: "ongoing",
    });
    expect((await turnsOf(donna.id)).at(-1)?.message).toBe(
      "Ray (agent): 20:42",
    );
  });
});

// ── The routes ──────────────────────────────────────────────────────────────

describe.skipIf(!PROOF_URL)("agent links (5b) — the routes", () => {
  const dashboard = (
    path: string,
    init: { method?: string; body?: unknown; workspaceId?: string } = {},
  ) =>
    app.request(path, {
      method: init.method ?? "GET",
      headers: {
        "content-type": "application/json",
        "x-workspace-id": init.workspaceId ?? WORKSPACE,
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });

  it("GET lists the peers; PUT sets THIS side (audited); a foreign workspace is 404; a bad body is 422", async () => {
    const { donna, ray } = await seedPair();
    currentSession = { id: OWNER, email: `${OWNER}@example.com` };
    try {
      const listed = await dashboard(`/v1/agents/${donna.id}/links`);
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({
        peers: [
          {
            agentId: ray.id,
            name: "Ray",
            workspaceName: null,
            myPolicy: "ask",
            theirPolicy: "ask",
            conversationId: null,
            paused: false,
            taskOpen: false,
          },
        ],
      });

      const set = await dashboard(`/v1/agents/${donna.id}/links/${ray.id}`, {
        method: "PUT",
        body: { policy: "blocked" },
      });
      expect(set.status).toBe(200);
      expect(await set.json()).toMatchObject({ policy: "blocked" });
      expect(await links.isLinkBlocked(donna.id, ray.id)).toBe(true);
      const audit = await db.auditLog.findFirst({
        where: { userId: OWNER, service: "agent", action: "update" },
        orderBy: { createdAt: "desc" },
      });
      expect(audit?.metadata).toMatchObject({
        agentId: donna.id,
        peerAgentId: ray.id,
        linkPolicy: "blocked",
      });

      // Ray's side reads the block as THEIRS.
      const rayView = await dashboard(`/v1/agents/${ray.id}/links`);
      expect((await rayView.json()).peers[0]).toMatchObject({
        agentId: donna.id,
        myPolicy: "ask",
        theirPolicy: "blocked",
      });

      // The fence: the other workspace does not own Donna.
      const foreign = await dashboard(
        `/v1/agents/${donna.id}/links/${ray.id}`,
        {
          method: "PUT",
          body: { policy: "allow" },
          workspaceId: OTHER_WORKSPACE,
        },
      );
      expect(foreign.status).toBe(404);
      expect(await links.isLinkBlocked(donna.id, ray.id)).toBe(true);

      const bad = await dashboard(`/v1/agents/${donna.id}/links/${ray.id}`, {
        method: "PUT",
        body: { policy: "forever" },
      });
      expect(bad.status).toBe(422);
    } finally {
      currentSession = null;
    }
  });

  it("DELETE /agents/:id/links/:peerId forgets this side (204, audited); a foreign workspace is 404", async () => {
    const { donna, ray } = await seedPair();
    await links.setLinkPolicy({
      workspaceId: WORKSPACE,
      agentId: donna.id,
      peerAgentId: ray.id,
      policy: "blocked",
      deciderUserId: OWNER,
    });
    currentSession = { id: OWNER, email: `${OWNER}@example.com` };
    try {
      const foreign = await dashboard(
        `/v1/agents/${donna.id}/links/${ray.id}`,
        {
          method: "DELETE",
          workspaceId: OTHER_WORKSPACE,
        },
      );
      expect(foreign.status).toBe(404);
      expect(await db.agentLink.count()).toBe(1);

      const res = await dashboard(`/v1/agents/${donna.id}/links/${ray.id}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(204);
      expect(await db.agentLink.count()).toBe(0);
      const audit = await db.auditLog.findFirst({
        where: { userId: OWNER, service: "agent", action: "delete" },
        orderBy: { createdAt: "desc" },
      });
      expect(audit?.metadata).toMatchObject({
        agentId: donna.id,
        peerAgentId: ray.id,
      });
    } finally {
      currentSession = null;
    }
  });

  it("POST /agents/:id/links/:peerId/resume lifts THIS side's pause (200 {paused:false}, audited, the row reads paused:false); a foreign workspace and a pair that never talked are 404", async () => {
    const { donna, ray } = await seedPair();
    for (const [a, b] of [
      [donna, ray],
      [ray, donna],
    ] as const) {
      await links.setLinkPolicy({
        workspaceId: WORKSPACE,
        agentId: a.id,
        peerAgentId: b.id,
        policy: "allow",
        deciderUserId: OWNER,
      });
    }
    await message(donna, "Ray", "hi");
    const inbox = (await pairConversationOf(ray.id, donna.id))!;
    await db.conversation.update({
      where: { id: inbox.id },
      data: { appTurnStreak: cap.APP_TURN_CAP + 1 },
    });
    currentSession = { id: OWNER, email: `${OWNER}@example.com` };
    try {
      const before = await (
        await dashboard(`/v1/agents/${ray.id}/links`)
      ).json();
      expect(before.peers[0]).toMatchObject({
        agentId: donna.id,
        paused: true,
      });

      const foreign = await dashboard(
        `/v1/agents/${ray.id}/links/${donna.id}/resume`,
        { method: "POST", workspaceId: OTHER_WORKSPACE },
      );
      expect(foreign.status).toBe(404);
      const zoe = await seedAgent("Zoe");
      const never = await dashboard(
        `/v1/agents/${ray.id}/links/${zoe.id}/resume`,
        { method: "POST" },
      );
      expect(never.status).toBe(404);
      expect((await pairConversationOf(ray.id, donna.id))?.appTurnStreak).toBe(
        cap.APP_TURN_CAP + 1,
      );

      const resumed = await dashboard(
        `/v1/agents/${ray.id}/links/${donna.id}/resume`,
        { method: "POST" },
      );
      expect(resumed.status).toBe(200);
      expect(await resumed.json()).toEqual({ paused: false });
      expect((await pairConversationOf(ray.id, donna.id))?.appTurnStreak).toBe(
        0,
      );
      const after = await (
        await dashboard(`/v1/agents/${ray.id}/links`)
      ).json();
      expect(after.peers[0]).toMatchObject({
        agentId: donna.id,
        paused: false,
      });
      const audit = await db.auditLog.findFirst({
        where: { userId: OWNER, service: "agent", action: "approve" },
        orderBy: { createdAt: "desc" },
      });
      expect(audit?.metadata).toMatchObject({
        agentId: ray.id,
        peerAgentId: donna.id,
        resumed: "pair_conversation",
      });
    } finally {
      currentSession = null;
    }
  });

  it("unauthenticated: 401, nothing read", async () => {
    const { donna } = await seedPair();
    const res = await dashboard(`/v1/agents/${donna.id}/links`);
    expect(res.status).toBe(401);
  });
});

// ── The tool door ───────────────────────────────────────────────────────────

describe.skipIf(!PROOF_URL)("agent links (5b) — the tool door", () => {
  it("message_agent through the REAL door: held, sent, blocked, and cap-paused each reach the model as its own words, never 'try again'", async () => {
    // The relay rule: `executePlatformTool` returns a ServiceError's message
    // and turns every other throw into "The tool failed unexpectedly. Try
    // again." A cap pause that read as "try again" would send the model
    // straight back into the paused thread - the loop the cap exists to
    // stop. Observed, not inspected: this is the door the sandbox calls.
    const { donna, ray } = await seedPair();
    const RUNNER = `${P}runner-door`;
    await db.runner.create({
      data: { id: RUNNER, name: "runner", token: `rnr_${P}door` },
    });
    await db.sandbox.create({
      data: {
        id: `${P}sb-door`,
        agentId: donna.id,
        runnerId: RUNNER,
        status: "running",
      },
    });
    const call = (args: unknown) =>
      platformTools.executePlatformTool(RUNNER, {
        sandboxId: `${P}sb-door`,
        tool: "message_agent",
        args,
      });

    // held: ask/ask.
    const held = await call({ to: "Ray", text: "hello" });
    expect(held.ok).toBe(true);
    expect(held).toMatchObject({
      result: { status: "held", to: "Ray" },
    });
    expect(await holdsFor(ray.id)).toHaveLength(1);

    // unknown name: the roster in the error.
    const unknown = await call({ to: "Rey", text: "hello" });
    expect(unknown.ok).toBe(false);
    expect(unknown).toMatchObject({
      error: 'No agent named "Rey". Agents you can message: Ray.',
    });

    // sent: allow/allow.
    for (const [a, b] of [
      [donna, ray],
      [ray, donna],
    ] as const) {
      await links.setLinkPolicy({
        workspaceId: WORKSPACE,
        agentId: a.id,
        peerAgentId: b.id,
        policy: "allow",
        deciderUserId: OWNER,
      });
    }
    const sent = await call({ to: "Ray", text: "ping 1" });
    expect(sent).toMatchObject({
      ok: true,
      result: { status: "sent", to: "Ray" },
    });
    expect((await turnsOf(ray.id)).map((t) => t.message)).toEqual([
      "Donna (agent): ping 1",
    ]);

    // cap-paused: the reason, with "don't retry" - NOT the generic line.
    for (let i = 2; i <= cap.APP_TURN_CAP; i += 1) {
      expect((await call({ to: "Ray", text: `ping ${i}` })).ok).toBe(true);
    }
    const paused = await call({ to: "Ray", text: "one too many" });
    expect(paused.ok).toBe(false);
    expect(paused).toMatchObject({
      error: expect.stringContaining(
        "Ray paused this conversation until a person continues it",
      ),
    });
    expect(paused).toMatchObject({ error: expect.stringContaining("retry") });
    expect(paused).not.toMatchObject({
      error: expect.stringContaining("Try again"),
    });

    // blocked: the standing no, in the model's terms.
    await links.setLinkPolicy({
      workspaceId: WORKSPACE,
      agentId: ray.id,
      peerAgentId: donna.id,
      policy: "blocked",
      deciderUserId: OWNER,
    });
    const blocked = await call({ to: "Ray", text: "still there?" });
    expect(blocked).toMatchObject({
      ok: false,
      error: "Ray's owner has blocked messages from you. Don't retry.",
    });

    // malformed args never reach the service.
    const bad = await call({ to: "Ray" });
    expect(bad.ok).toBe(false);
  });
});
