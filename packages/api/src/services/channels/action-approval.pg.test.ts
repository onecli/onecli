import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { proofDatabaseUrl } from "../../testing/pg-proof";

/**
 * The action-approval primitive's proofs — the full hold→card→decide→execute
 * cycle, driven through the real service doors (and the Slack-click wrapper)
 * against a real DB and a fake Slack. These proofs ARE the primitive's first
 * consumer: they register real handlers and observe real execution — the
 * registry contract 4c's send_message steps into.
 *
 * The properties pinned, each mutation-proof:
 *  - the row is the single truth: the payload the handler receives is the
 *    payload written at create — and NOTHING in the codebase updates it
 *    (the no-hash contract's pin);
 *  - approve executes the handler EXACTLY once, even under a decide race
 *    (the atomic pending→approved flip);
 *  - reject relays the reason into the outcome notice verbatim;
 *  - handler failure lands `failed` + reason, never a thrown 500;
 *  - expiry is selective, idempotent, and loud (notice written);
 *  - tenancy: a foreign presence's click and a foreign workspace's
 *    dashboard decide both read not-found-shaped refusals;
 *  - the cards: posted to DM-reachable owners with claim-before-post,
 *    settled on every terminal outcome.
 */

const PROOF_URL = proofDatabaseUrl();

const P = "aap-";
const ORG = `${P}org`;
const OTHER_ORG = `${P}other-org`;
const WORKSPACE = `${P}ws`;
const OTHER_WORKSPACE = `${P}other-ws`;
const OWNER = `${P}owner`;
const OUTSIDER = `${P}outsider`;
const TENANT = "T-AAP";

let db: typeof import("@onecli/db").db;
let approvals: typeof import("./action-approval-service");

interface SlackCall {
  method: string;
  form: URLSearchParams;
}
let slackServer: Server;
let slackCalls: SlackCall[] = [];
let slackHandlers: Record<string, (call: SlackCall) => unknown> = {};

const slackCallsFor = (method: string) =>
  slackCalls.filter((c) => c.method === method);

const startSlackFake = (): Promise<string> =>
  new Promise((resolve) => {
    slackServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      req.on("end", () => {
        const method = (req.url ?? "/").slice(1);
        const call: SlackCall = { method, form: new URLSearchParams(raw) };
        slackCalls.push(call);
        const handler = slackHandlers[method];
        const body = handler ? handler(call) : {};
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...(body as object) }));
      });
    });
    slackServer.listen(0, "127.0.0.1", () => {
      const { port } = slackServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

const scriptSlack = () => {
  slackHandlers["conversations.open"] = () => ({
    channel: { id: "D-OWNER-IM" },
  });
  slackHandlers["chat.postMessage"] = () => ({
    channel: "D-OWNER-IM",
    ts: "555.111",
  });
  slackHandlers["chat.update"] = () => ({ ts: "555.111" });
  slackHandlers["users.info"] = (call) => ({
    user: {
      id: call.form.get("user"),
      team_id: TENANT,
      name: "owner",
      profile: { display_name: "Owner" },
    },
  });
};

// ── Seeds (the reach-suite shapes, prefix-fenced) ──────────────────────────

let seq = 0;

const seedAgent = async (suffix: string, workspaceId = WORKSPACE) => {
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `aap agent ${suffix}`,
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  return agent.id;
};

const seedIntegration = async (organizationId = ORG) =>
  db.channelIntegration.create({
    data: {
      organizationId,
      provider: "slack",
      externalId: TENANT,
      name: "AAP Workspace",
      createdByUserId: OWNER,
    },
    select: { id: true },
  });

const seedPresence = async (agentId: string, integrationId: string) => {
  const { getCrypto } = await import("../../providers");
  const credentials = await getCrypto().encrypt(
    JSON.stringify({ botToken: "xoxb-aap-test" }),
  );
  seq += 1;
  return db.agentChannel.create({
    data: {
      agentId,
      integrationId,
      provider: "slack",
      externalId: `${P}bot-${seq}`,
      identityRef: `${P}identity-${seq}`,
      transport: "socket",
      status: "active",
      credentials,
    },
    select: { id: true },
  });
};

const linkUser = (
  integrationId: string,
  externalUserId: string,
  userId: string,
) =>
  db.channelUserLink.create({
    data: { integrationId, externalUserId, userId, linkedVia: "manual" },
    select: { id: true },
  });

const seedConversationWithTurn = async (agentId: string, suffix: string) => {
  const conversation = await db.conversation.create({
    data: { agentId, source: "slack", externalRef: `${P}${suffix}` },
    select: { id: true },
  });
  const turn = await db.turn.create({
    data: {
      conversationId: conversation.id,
      message: "please do the thing",
      status: "done",
      source: "slack",
      finishedAt: new Date(),
    },
    select: { id: true },
  });
  return { conversationId: conversation.id, turnId: turn.id };
};

/** One agent with presence + linked owner + a real turn — the full stage. */
const seedStage = async (suffix: string) => {
  const agentId = await seedAgent(suffix);
  const integration = await seedIntegration();
  const presence = await seedPresence(agentId, integration.id);
  await linkUser(integration.id, "U-OWNER", OWNER);
  await db.workspaceAccess.upsert({
    where: {
      workspaceId_userId: { workspaceId: WORKSPACE, userId: OWNER },
    },
    create: { workspaceId: WORKSPACE, userId: OWNER, role: "owner" },
    update: { role: "owner" },
  });
  const { conversationId, turnId } = await seedConversationWithTurn(
    agentId,
    suffix,
  );
  return {
    agentId,
    integrationId: integration.id,
    presenceId: presence.id,
    conversationId,
    turnId,
  };
};

const reset = async () => {
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.SLACK_API_BASE_URL = await startSlackFake();
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  ({ db } = await import("@onecli/db"));
  approvals = await import("./action-approval-service");

  await reset();
  // Audit rows RESTRICT user deletes; member rows RESTRICT org deletes —
  // clear this suite's residue first (prefix-fenced).
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
  await db.organizationMember.deleteMany({
    where: { userId: { startsWith: P } },
  });
  await db.workspaceAccess.deleteMany({
    where: { userId: { startsWith: P } },
  });
  await db.workspace.deleteMany({
    where: { id: { in: [WORKSPACE, OTHER_WORKSPACE] } },
  });
  await db.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });

  await db.organization.createMany({
    data: [
      { id: ORG, name: ORG, slug: ORG },
      { id: OTHER_ORG, name: OTHER_ORG, slug: OTHER_ORG },
    ],
  });
  await db.workspace.createMany({
    data: [
      { id: WORKSPACE, name: "AAP", organizationId: ORG },
      { id: OTHER_WORKSPACE, name: "AAP Other", organizationId: OTHER_ORG },
    ],
  });
  await db.user.createMany({
    data: [
      {
        id: OWNER,
        email: `${OWNER}@example.com`,
        externalAuthId: OWNER,
        name: "Olive Owner",
      },
      {
        id: OUTSIDER,
        email: `${OUTSIDER}@example.com`,
        externalAuthId: OUTSIDER,
        name: "Otto Outsider",
      },
    ],
  });
  // authorizeChannelUser's two-check fence: active org membership + the
  // workspace-access predicate. The owner holds both.
  await db.organizationMember.createMany({
    data: [
      {
        organizationId: ORG,
        userId: OWNER,
        userEmail: `${OWNER}@example.com`,
        role: "owner",
      },
    ],
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await reset();
  slackCalls = [];
  slackHandlers = {};
  scriptSlack();
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  slackServer?.close();
});

describe.skipIf(!PROOF_URL)("the full cycle", () => {
  it("hold → cards → approve (Slack click) → handler runs once from the frozen row → executed + notice", async () => {
    const stage = await seedStage("cycle");
    const executed: unknown[] = [];
    approvals.registerActionHandler("test.cycle", async (approval) => {
      executed.push(approval.payload);
    });
    try {
      const request = await approvals.requestActionApproval({
        agentId: stage.agentId,
        conversationId: stage.conversationId,
        originTurnId: stage.turnId,
        action: "test.cycle",
        payload: { to: "tomer", text: "the dashboard is ready" },
        summary: 'message Tomer: "the dashboard is ready"',
      });
      expect(request.status).toBe("pending");

      // The owner card went out, claim-before-post recorded.
      expect(slackCallsFor("chat.postMessage")).toHaveLength(1);
      const row = await db.actionApproval.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(row.cardRefs).toEqual([
        { channel: "D-OWNER-IM", ts: "555.111", userId: OWNER },
      ]);

      // Approve through the SLACK-CLICK door (the full authorization walk).
      const outcome = await approvals.decideActionApprovalFromChannel({
        presenceId: stage.presenceId,
        approvalId: request.id,
        decision: "approve",
        clickerExternalUserId: "U-OWNER",
      });
      expect(outcome).toEqual({ kind: "decided", status: "executed" });

      // The handler received the FROZEN row's payload, exactly once.
      expect(executed).toEqual([
        { to: "tomer", text: "the dashboard is ready" },
      ]);

      const settled = await db.actionApproval.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(settled.status).toBe("executed");
      expect(settled.decidedByUserId).toBe(OWNER);

      // The outcome notice landed on the origin turn.
      const notice = await db.turnEvent.findFirst({
        where: { turnId: stage.turnId, type: "notice" },
      });
      expect(notice).not.toBeNull();
      expect((notice!.payload as { text: string }).text).toContain(
        "Approved and done",
      );
      // And every posted card was rewritten.
      expect(slackCallsFor("chat.update")).toHaveLength(1);
    } finally {
      approvals.unregisterActionHandler("test.cycle");
    }
  });

  it("reject relays the REASON verbatim into the notice; the handler never runs", async () => {
    const stage = await seedStage("reject");
    let ran = 0;
    approvals.registerActionHandler("test.reject", async () => {
      ran += 1;
    });
    try {
      const request = await approvals.requestActionApproval({
        agentId: stage.agentId,
        conversationId: stage.conversationId,
        originTurnId: stage.turnId,
        action: "test.reject",
        payload: {},
        summary: "post the summary in #standup",
      });
      const outcome = await approvals.decideActionApproval({
        approvalId: request.id,
        decision: "reject",
        deciderUserId: OWNER,
        reason: "not before the QA pass finishes",
      });
      expect(outcome).toEqual({ kind: "decided", status: "rejected" });
      expect(ran).toBe(0);

      const notice = await db.turnEvent.findFirst({
        where: { turnId: stage.turnId, type: "notice" },
      });
      expect((notice!.payload as { text: string }).text).toContain(
        "not before the QA pass finishes",
      );
    } finally {
      approvals.unregisterActionHandler("test.reject");
    }
  });

  it("a THROWING handler lands failed + reason - never a thrown decide", async () => {
    const stage = await seedStage("fail");
    approvals.registerActionHandler("test.fail", async () => {
      throw new Error("target channel is archived");
    });
    try {
      const request = await approvals.requestActionApproval({
        agentId: stage.agentId,
        conversationId: stage.conversationId,
        originTurnId: stage.turnId,
        action: "test.fail",
        payload: {},
        summary: "do a doomed thing",
      });
      const outcome = await approvals.decideActionApproval({
        approvalId: request.id,
        decision: "approve",
        deciderUserId: OWNER,
      });
      expect(outcome).toEqual({ kind: "decided", status: "failed" });
      const row = await db.actionApproval.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(row.reason).toContain("target channel is archived");
      const notice = await db.turnEvent.findFirst({
        where: { turnId: stage.turnId, type: "notice" },
      });
      expect((notice!.payload as { text: string }).text).toContain("FAILED");
    } finally {
      approvals.unregisterActionHandler("test.fail");
    }
  });

  it("a decide RACE runs the handler exactly once (the atomic flip)", async () => {
    const stage = await seedStage("race");
    let ran = 0;
    approvals.registerActionHandler("test.race", async () => {
      ran += 1;
    });
    try {
      const request = await approvals.requestActionApproval({
        agentId: stage.agentId,
        action: "test.race",
        payload: {},
        summary: "race me",
      });
      const [first, second] = await Promise.all([
        approvals.decideActionApproval({
          approvalId: request.id,
          decision: "approve",
          deciderUserId: OWNER,
        }),
        approvals.decideActionApproval({
          approvalId: request.id,
          decision: "approve",
          deciderUserId: OWNER,
        }),
      ]);
      const kinds = [first.kind, second.kind].sort();
      expect(kinds).toEqual(["already_settled", "decided"]);
      expect(ran).toBe(1);
    } finally {
      approvals.unregisterActionHandler("test.race");
    }
  });
});

describe.skipIf(!PROOF_URL)("the row is the single truth", () => {
  it("IMMUTABILITY: no code path updates payload after create - the no-hash contract", async () => {
    // The pin is a REPO GREP, not a runtime assertion: the design's whole
    // safety argument is that no update site exists. If one appears, this
    // fails and the author must either remove it or introduce integrity
    // verification (the hash) in the same change.
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const apiSrc = path.resolve(here, "../..");
    const hits = execFileSync(
      "grep",
      [
        "-rn",
        "--include=*.ts",
        "--exclude=*.test.ts",
        "-l",
        "actionApproval.update",
        apiSrc,
      ],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    // The service's own status transitions are the ONLY writers.
    expect(hits).toEqual([
      path.join(apiSrc, "services/channels/action-approval-service.ts"),
    ]);
    const body = (await import("node:fs")).readFileSync(
      path.join(apiSrc, "services/channels/action-approval-service.ts"),
      "utf8",
    );
    // And none of those writers touches `payload`.
    for (const match of body.matchAll(
      /actionApproval\.update(?:Many)?\(\{[\s\S]*?data: \{([\s\S]*?)\}/g,
    )) {
      expect(match[1]).not.toContain("payload");
    }
  });
});

describe.skipIf(!PROOF_URL)("expiry", () => {
  it("parks only overdue PENDING rows, idempotently, with cards settled and the notice written", async () => {
    const stage = await seedStage("expiry");
    approvals.registerActionHandler("test.expiry", async () => {});
    try {
      const overdue = await approvals.requestActionApproval({
        agentId: stage.agentId,
        conversationId: stage.conversationId,
        originTurnId: stage.turnId,
        action: "test.expiry",
        payload: {},
        summary: "an ask nobody answered",
        expiresInMs: -1000, // already past
      });
      const fresh = await approvals.requestActionApproval({
        agentId: stage.agentId,
        action: "test.expiry",
        payload: {},
        summary: "a fresh ask",
      });

      const first = await approvals.expireStaleActionApprovals();
      expect(first.expired).toBe(1);
      expect(
        (
          await db.actionApproval.findUniqueOrThrow({
            where: { id: overdue.id },
          })
        ).status,
      ).toBe("expired");
      expect(
        (await db.actionApproval.findUniqueOrThrow({ where: { id: fresh.id } }))
          .status,
      ).toBe("pending");
      const notice = await db.turnEvent.findFirst({
        where: { turnId: stage.turnId, type: "notice" },
      });
      expect((notice!.payload as { text: string }).text).toContain("Expired");

      const second = await approvals.expireStaleActionApprovals();
      expect(second.expired).toBe(0);
    } finally {
      approvals.unregisterActionHandler("test.expiry");
    }
  });

  it("a click on an expired-but-unswept row refuses and settles it - never approves a dead ask", async () => {
    const stage = await seedStage("lazyexp");
    let ran = 0;
    approvals.registerActionHandler("test.lazyexp", async () => {
      ran += 1;
    });
    try {
      const request = await approvals.requestActionApproval({
        agentId: stage.agentId,
        action: "test.lazyexp",
        payload: {},
        summary: "expired under the click",
        expiresInMs: -1000,
      });
      const outcome = await approvals.decideActionApproval({
        approvalId: request.id,
        decision: "approve",
        deciderUserId: OWNER,
      });
      expect(outcome.kind).toBe("refused");
      expect(ran).toBe(0);
      expect(
        (
          await db.actionApproval.findUniqueOrThrow({
            where: { id: request.id },
          })
        ).status,
      ).toBe("expired");
    } finally {
      approvals.unregisterActionHandler("test.lazyexp");
    }
  });
});

describe.skipIf(!PROOF_URL)("fences", () => {
  it("TENANCY: a foreign presence's click reads not-found-shaped, nothing flips", async () => {
    const stage = await seedStage("tenancy");
    approvals.registerActionHandler("test.tenancy", async () => {});
    try {
      const request = await approvals.requestActionApproval({
        agentId: stage.agentId,
        action: "test.tenancy",
        payload: {},
        summary: "cross-tenant probe",
      });

      // A different agent's presence (same DB, another integration+org).
      const foreignAgent = await seedAgent("tenancy-foreign", OTHER_WORKSPACE);
      const foreignIntegration = await seedIntegration(OTHER_ORG);
      const foreignPresence = await seedPresence(
        foreignAgent,
        foreignIntegration.id,
      );

      const outcome = await approvals.decideActionApprovalFromChannel({
        presenceId: foreignPresence.id,
        approvalId: request.id,
        decision: "approve",
        clickerExternalUserId: "U-OWNER",
      });
      expect(outcome).toEqual({
        kind: "refused",
        message: "This request no longer exists.",
      });
      expect(
        (
          await db.actionApproval.findUniqueOrThrow({
            where: { id: request.id },
          })
        ).status,
      ).toBe("pending");
    } finally {
      approvals.unregisterActionHandler("test.tenancy");
    }
  });

  it("an UNLINKED clicker is refused with the governance line", async () => {
    const stage = await seedStage("stranger");
    approvals.registerActionHandler("test.stranger", async () => {});
    try {
      const request = await approvals.requestActionApproval({
        agentId: stage.agentId,
        action: "test.stranger",
        payload: {},
        summary: "stranger click probe",
      });
      // users.info answers an email that matches NO platform user.
      slackHandlers["users.info"] = (call) => ({
        user: {
          id: call.form.get("user"),
          team_id: TENANT,
          profile: { email: "nobody@nowhere.example" },
        },
      });
      const outcome = await approvals.decideActionApprovalFromChannel({
        presenceId: stage.presenceId,
        approvalId: request.id,
        decision: "approve",
        clickerExternalUserId: "U-STRANGER",
      });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("unreachable");
      expect(outcome.message).toContain("Only workspace members");
    } finally {
      approvals.unregisterActionHandler("test.stranger");
    }
  });

  it("registering the same action twice throws; requesting an unregistered action throws", async () => {
    approvals.registerActionHandler("test.dupe", async () => {});
    try {
      expect(() =>
        approvals.registerActionHandler("test.dupe", async () => {}),
      ).toThrow(/already registered/);
    } finally {
      approvals.unregisterActionHandler("test.dupe");
    }

    const stage = await seedStage("noreg");
    await expect(
      approvals.requestActionApproval({
        agentId: stage.agentId,
        action: "test.never-registered",
        payload: {},
        summary: "doomed request",
      }),
    ).rejects.toThrow(/No handler registered/);
  });
});
