import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { proofDatabaseUrl } from "../testing/pg-proof";

/**
 * Agent-proposed custom connections over the REAL wire (stage 2): the
 * platform tool holds a proposal, the person approves it in the dashboard
 * with the key, and exactly one encrypted secret lands, granted to the
 * proposing agent only. Pinned, each mutation-proof:
 *
 *  - the dedicated route is workspace-, agent- and action-fenced
 *    (not-found-shaped), refuses non-pending (409), an empty key (422) and
 *    non-session callers (403);
 *  - a double approve creates ONE secret (the atomic flip);
 *  - the generic decide route and the Slack click can REJECT but never
 *    APPROVE it, and the Slack card is link-only;
 *  - the key text appears in no turn_events, action_approvals or
 *    audit_logs row, and the secret's stored value is ciphertext;
 *  - the grant goes to the proposer only (no workspace auto-attach), and
 *    SECRET CREATE is audited with ids + host.
 */

const PROOF_URL = proofDatabaseUrl();

const P = "ccwire-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OTHER_ORG = `${P}other-org`;
const OTHER_WORKSPACE = `${P}other-ws`;
const OWNER = `${P}owner`;
const TENANT = "T-CCWIRE";
const SELF_URL = "https://api.ccwire.test";
const KEY = "acmecrm-live-KEY-7c1e9a55f0";

type Db = typeof import("@onecli/db").db;
let db: Db;
let app: ReturnType<typeof import("../app").createApiApp>;
let tools: typeof import("../services/platform-tool-service");
let approvals: typeof import("../services/channels/action-approval-service");

let currentSession: { id: string; email: string } | null = null;

let slackServer: Server;
let slackCalls: { method: string; form: URLSearchParams }[] = [];

const startSlackFake = (): Promise<string> =>
  new Promise((resolve) => {
    slackServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      req.on("end", () => {
        const method = (req.url ?? "/").slice(1);
        slackCalls.push({ method, form: new URLSearchParams(raw) });
        const body =
          method === "conversations.open"
            ? { channel: { id: "D-OWNER" } }
            : method === "chat.postMessage"
              ? { channel: "D-OWNER", ts: "1.1" }
              : method === "users.info"
                ? { user: { id: "U-OWNER", team_id: TENANT } }
                : {};
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...body }));
      });
    });
    slackServer.listen(0, "127.0.0.1", () => {
      const { port } = slackServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

const proposal = {
  name: `${P}AcmeCRM`,
  hostPattern: "api.acmecrm.io",
  headerName: "X-Api-Key",
  valueFormat: "{value}",
  docsUrl: "https://docs.acmecrm.io/auth",
  reason: "You asked for your AcmeCRM campaigns.",
};

let seq = 0;

/** An agent (+ an optional Slack presence the owner is linked on) with a
 * runner/sandbox and a conversation turn, so the platform tool runs for
 * real. */
const seedStage = async (opts: { slack?: boolean } = {}) => {
  seq += 1;
  const agent = await db.agent.create({
    data: {
      workspaceId: WORKSPACE,
      name: `cc agent ${seq}`,
      identifier: `${P}a${seq}`,
      accessToken: `aoc_${P}a${seq}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  // A bystander agent in the same workspace: must NOT get the grant.
  const bystander = await db.agent.create({
    data: {
      workspaceId: WORKSPACE,
      name: `cc bystander ${seq}`,
      identifier: `${P}b${seq}`,
      accessToken: `aoc_${P}b${seq}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  const runner = await db.runner.create({
    data: { name: `${P}r${seq}`, token: `rnr_${P}${seq}` },
    select: { id: true },
  });
  const sandbox = await db.sandbox.create({
    data: { agentId: agent.id, runnerId: runner.id },
    select: { id: true },
  });
  const conversation = await db.conversation.create({
    data: { agentId: agent.id, source: "web" },
    select: { id: true },
  });
  const turn = await db.turn.create({
    data: {
      conversationId: conversation.id,
      message: "connect me to AcmeCRM",
      source: "web",
      userId: OWNER,
    },
    select: { id: true },
  });
  let presenceId: string | null = null;
  if (opts.slack) {
    const { getCrypto } = await import("../providers");
    const integration = await db.channelIntegration.create({
      data: {
        organizationId: ORG,
        provider: "slack",
        externalId: TENANT,
        name: "CC",
        createdByUserId: OWNER,
      },
      select: { id: true },
    });
    const presence = await db.agentChannel.create({
      data: {
        agentId: agent.id,
        integrationId: integration.id,
        provider: "slack",
        externalId: `${P}bot-${seq}`,
        identityRef: `${P}id-${seq}`,
        transport: "socket",
        status: "active",
        credentials: await getCrypto().encrypt(
          JSON.stringify({ botToken: "xoxb-cc" }),
        ),
      },
      select: { id: true },
    });
    await db.channelUserLink.create({
      data: {
        integrationId: integration.id,
        externalUserId: "U-OWNER",
        userId: OWNER,
        linkedVia: "manual",
      },
    });
    presenceId = presence.id;
  }
  return {
    agentId: agent.id,
    bystanderId: bystander.id,
    runnerId: runner.id,
    sandboxId: sandbox.id,
    conversationId: conversation.id,
    turnId: turn.id,
    presenceId,
  };
};

const propose = async (
  stage: Awaited<ReturnType<typeof seedStage>>,
  args: unknown = proposal,
) => {
  const res = await tools.executePlatformTool(stage.runnerId, {
    sandboxId: stage.sandboxId,
    tool: "propose_custom_connection",
    args,
    conversationId: stage.conversationId,
    turnId: stage.turnId,
  });
  if (!res.ok) throw new Error(`propose refused: ${JSON.stringify(res)}`);
  const result = res.result as { approvalId: string };
  return result.approvalId;
};

const approveRoute = (
  agentId: string,
  approvalId: string,
  body: unknown,
  workspaceId = WORKSPACE,
) =>
  app.request(
    `/v1/agents/${agentId}/approvals/${approvalId}/custom-connection`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-workspace-id": workspaceId,
      },
      body: JSON.stringify(body),
    },
  );

const decideRoute = (agentId: string, approvalId: string, body: unknown) =>
  app.request(`/v1/agents/${agentId}/approvals/${approvalId}/decision`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-workspace-id": WORKSPACE,
    },
    body: JSON.stringify(body),
  });

const secretsNamed = () =>
  db.secret.findMany({
    where: { name: proposal.name, workspaceId: WORKSPACE },
    select: { id: true, encryptedValue: true, injectionConfig: true },
  });

const grantedAgents = async (
  secretId: string,
  status: "draft" | "published" = "draft",
) =>
  (
    await db.policyRuleIdentity.findMany({
      where: {
        rule: { targets: { some: { secretId } }, status },
      },
      select: { agentId: true },
    })
  ).map((r) => r.agentId);

const reset = async () => {
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
  await db.policyRuleTarget.deleteMany({
    where: { rule: { workspaceId: WORKSPACE } },
  });
  await db.policyRuleIdentity.deleteMany({
    where: { rule: { workspaceId: WORKSPACE } },
  });
  await db.policyRuleV2.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.secret.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { name: { startsWith: P } } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.SLACK_API_BASE_URL = await startSlackFake();
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.APP_URL = "https://app.ccwire.test";

  ({ db } = await import("@onecli/db"));
  const providers = await import("../providers");
  providers.initSelfUrl(SELF_URL);
  const { createApiApp } = await import("../app");
  app = createApiApp(
    { getSession: async () => currentSession },
    { selfUrl: SELF_URL },
  );
  tools = await import("../services/platform-tool-service");
  approvals = await import("../services/channels/action-approval-service");

  await reset();
  await db.organizationMember.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
  await db.workspaceAccess.deleteMany({
    where: { workspaceId: { in: [WORKSPACE, OTHER_WORKSPACE] } },
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
      { id: WORKSPACE, name: "CC", organizationId: ORG },
      { id: OTHER_WORKSPACE, name: "CC other", organizationId: OTHER_ORG },
    ],
  });
  await db.user.create({
    data: {
      id: OWNER,
      email: `${OWNER}@example.com`,
      externalAuthId: OWNER,
      name: "Olive Owner",
    },
  });
  // The owner can reach BOTH workspaces, so the other-workspace fence is
  // the route's own, not the auth layer's.
  await db.organizationMember.createMany({
    data: [
      {
        organizationId: ORG,
        userId: OWNER,
        userEmail: `${OWNER}@example.com`,
        role: "owner",
      },
      {
        organizationId: OTHER_ORG,
        userId: OWNER,
        userEmail: `${OWNER}@example.com`,
        role: "owner",
      },
    ],
  });
  await db.workspaceAccess.createMany({
    data: [
      { workspaceId: WORKSPACE, userId: OWNER, role: "owner" },
      { workspaceId: OTHER_WORKSPACE, userId: OWNER, role: "owner" },
    ],
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await reset();
  slackCalls = [];
  currentSession = { id: OWNER, email: `${OWNER}@example.com` };
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.organizationMember.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
  await db.workspaceAccess.deleteMany({
    where: { workspaceId: { in: [WORKSPACE, OTHER_WORKSPACE] } },
  });
  await db.workspace.deleteMany({
    where: { id: { in: [WORKSPACE, OTHER_WORKSPACE] } },
  });
  await db.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
  await new Promise<void>((r) => slackServer.close(() => r()));
});

describe.skipIf(!PROOF_URL)("approve with the key", () => {
  it("creates exactly one encrypted secret, granted to the proposer only, audited, and the key is nowhere else", async () => {
    const stage = await seedStage();
    const approvalId = await propose(stage);

    const res = await approveRoute(stage.agentId, approvalId, { value: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      kind: "decided",
      status: "executed",
    });

    const secrets = await secretsNamed();
    expect(secrets).toHaveLength(1);
    const secret = secrets[0]!;
    expect(secret.encryptedValue).toBeTruthy();
    expect(secret.encryptedValue).not.toContain(KEY);
    expect(secret.injectionConfig).toEqual({
      headerName: "X-Api-Key",
      valueFormat: "{value}",
    });

    // The proposer, and ONLY the proposer (no workspace auto-attach), and
    // PUBLISHED: the gateway reads published rules, so a draft-only grant
    // would leave the new connection dead.
    const granted = await grantedAgents(secret.id);
    expect(granted).toContain(stage.agentId);
    expect(granted).not.toContain(stage.bystanderId);
    expect(await grantedAgents(secret.id, "published")).toEqual([
      stage.agentId,
    ]);
    expect(
      await db.auditLog.findFirst({
        where: { workspaceId: WORKSPACE, service: "grant", action: "update" },
        select: { metadata: true },
      }),
    ).toMatchObject({
      metadata: { agentId: stage.agentId, secretId: secret.id, approvalId },
    });

    const audit = await db.auditLog.findFirst({
      where: { workspaceId: WORKSPACE, service: "secret", action: "create" },
      select: { metadata: true, userId: true, source: true },
    });
    expect(audit).toMatchObject({
      userId: OWNER,
      source: "api",
      metadata: {
        secretId: secret.id,
        agentId: stage.agentId,
        approvalId,
        host: "api.acmecrm.io",
      },
    });

    // The outcome notice reached the asking turn with the id + test hint.
    const row = await db.actionApproval.findUniqueOrThrow({
      where: { id: approvalId },
      select: { status: true, payload: true, reason: true },
    });
    expect(row.status).toBe("executed");
    expect(row.reason).toContain(secret.id);
    expect(row.reason).toContain("read-only GET");

    // The key text is in NO durable row but the ciphertext.
    const [events, approvalRows, audits] = await Promise.all([
      db.turnEvent.findMany({
        where: { conversationId: stage.conversationId },
        select: { payload: true },
      }),
      db.actionApproval.findMany({ where: { agentId: stage.agentId } }),
      db.auditLog.findMany({ where: { workspaceId: WORKSPACE } }),
    ]);
    const dump = JSON.stringify({ events, approvalRows, audits });
    expect(dump).not.toContain(KEY);
    expect(events.length).toBeGreaterThan(0); // the notice was written

    // The agent is resumed: exactly one approver message lands in the same
    // thread (a new turn, or a follow-up on the still-running one): fixed
    // platform text, no agent-written name, never the key.
    const resumes = await db.turn.findMany({
      where: {
        conversationId: stage.conversationId,
        message: { endsWith: "connection approved and details provided." },
      },
      select: { message: true, userId: true, source: true },
    });
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({ userId: OWNER, source: "web" });
    expect(resumes[0]!.message).toMatch(
      /^\S*Custom connection approved and details provided\.$/,
    );
    expect(resumes[0]!.message).not.toContain("AcmeCRM");
    expect(resumes[0]!.message).not.toContain(KEY);
  });

  it("a double approve creates ONE secret; the second reads 409", async () => {
    const stage = await seedStage();
    const approvalId = await propose(stage);
    const [a, b] = await Promise.all([
      approveRoute(stage.agentId, approvalId, { value: KEY }),
      approveRoute(stage.agentId, approvalId, { value: KEY }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await secretsNamed()).toHaveLength(1);
  });
});

describe.skipIf(!PROOF_URL)("route fences", () => {
  it("another workspace, another agent, an unknown id, or another action: not found, nothing created", async () => {
    const stage = await seedStage();
    const other = await seedStage();
    const approvalId = await propose(stage);

    expect(
      (
        await approveRoute(
          stage.agentId,
          approvalId,
          { value: KEY },
          OTHER_WORKSPACE,
        )
      ).status,
    ).toBe(404);
    expect(
      (await approveRoute(other.agentId, approvalId, { value: KEY })).status,
    ).toBe(404);
    expect(
      (await approveRoute(stage.agentId, "nope", { value: KEY })).status,
    ).toBe(404);

    approvals.registerActionHandler("test.cc.other", async () => {});
    try {
      const foreign = await approvals.requestActionApproval({
        agentId: stage.agentId,
        action: "test.cc.other",
        payload: {},
        summary: "something else",
      });
      expect(
        (await approveRoute(stage.agentId, foreign.id, { value: KEY })).status,
      ).toBe(404);
    } finally {
      approvals.unregisterActionHandler("test.cc.other");
    }
    expect(await secretsNamed()).toHaveLength(0);
  });

  it("an empty key is 422 and leaves the ask pending; a settled ask is 409", async () => {
    const stage = await seedStage();
    const approvalId = await propose(stage);
    const empty = await approveRoute(stage.agentId, approvalId, {
      value: "  ",
    });
    expect(empty.status).toBe(422);
    expect(JSON.stringify(await empty.json())).not.toContain('  "value"');
    expect(
      (
        await db.actionApproval.findUniqueOrThrow({
          where: { id: approvalId },
        })
      ).status,
    ).toBe("pending");

    const decline = await decideRoute(stage.agentId, approvalId, {
      decision: "reject",
      reason: "use the EU host",
    });
    expect(decline.status).toBe(200);
    expect(
      (await approveRoute(stage.agentId, approvalId, { value: KEY })).status,
    ).toBe(409);
    expect(await secretsNamed()).toHaveLength(0);
  });

  it("an unauthenticated caller is refused", async () => {
    const stage = await seedStage();
    const approvalId = await propose(stage);
    currentSession = null;
    const res = await approveRoute(stage.agentId, approvalId, { value: KEY });
    expect(res.status).toBe(401);
    expect(await secretsNamed()).toHaveLength(0);
  });
});

describe.skipIf(!PROOF_URL)("the generic doors can't approve it", () => {
  it("the dashboard decision route refuses approve and approve_always (422), the ask stays pending", async () => {
    const stage = await seedStage();
    const approvalId = await propose(stage);
    for (const decision of ["approve", "approve_always"]) {
      const res = await decideRoute(stage.agentId, approvalId, { decision });
      expect(res.status).toBe(422);
    }
    expect(
      (
        await db.actionApproval.findUniqueOrThrow({
          where: { id: approvalId },
        })
      ).status,
    ).toBe("pending");
    expect(await secretsNamed()).toHaveLength(0);
  });

  it("the Slack card is link-only, and a forged Slack approve refuses without flipping", async () => {
    const stage = await seedStage({ slack: true });
    const approvalId = await propose(stage);

    const post = slackCalls.find((c) => c.method === "chat.postMessage");
    expect(post).toBeDefined();
    const blocks = JSON.parse(post!.form.get("blocks") ?? "[]") as {
      type: string;
      elements?: { action_id: string; url?: string }[];
    }[];
    const buttons = blocks.flatMap((b) => b.elements ?? []);
    expect(buttons.map((b) => b.action_id)).toEqual(["action_review_link"]);
    expect(buttons[0]?.url).toBe(
      `https://app.ccwire.test/w/${WORKSPACE}/agents/${stage.agentId}/chat`,
    );

    const outcome = await approvals.decideActionApprovalFromChannel({
      presenceId: stage.presenceId!,
      approvalId,
      decision: "approve",
      clickerExternalUserId: "U-OWNER",
    });
    expect(outcome.kind).toBe("refused");
    expect(
      (
        await db.actionApproval.findUniqueOrThrow({
          where: { id: approvalId },
        })
      ).status,
    ).toBe("pending");
    expect(await secretsNamed()).toHaveLength(0);
  });
});

describe.skipIf(!PROOF_URL)("re-validation at approve time", () => {
  it("a payload that no longer passes the policy fails without creating anything", async () => {
    const stage = await seedStage();
    const approvalId = await propose(stage);
    // Simulate a payload that would be refused today (a catalog host).
    await db.actionApproval.update({
      where: { id: approvalId },
      data: { payload: { ...proposal, hostPattern: "api.github.com" } },
    });
    const res = await approveRoute(stage.agentId, approvalId, { value: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "failed" });
    expect(await secretsNamed()).toHaveLength(0);
    const row = await db.actionApproval.findUniqueOrThrow({
      where: { id: approvalId },
      select: { reason: true },
    });
    expect(row.reason).not.toContain(KEY);
  });
});

describe.skipIf(!PROOF_URL)(
  "POST /v1/secrets audit (the research finding)",
  () => {
    it("audits SECRET CREATE with ids and names, never the value", async () => {
      const res = await app.request("/v1/secrets", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-workspace-id": WORKSPACE,
        },
        body: JSON.stringify({
          name: `${P}direct`,
          type: "generic",
          value: KEY,
          hostPattern: "api.acmecrm.io",
          injectionConfig: { headerName: "X-Api-Key" },
        }),
      });
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      const audit = await db.auditLog.findFirst({
        where: { workspaceId: WORKSPACE, service: "secret", action: "create" },
        select: { metadata: true, source: true, userId: true },
      });
      expect(audit).toMatchObject({
        userId: OWNER,
        source: "api",
        metadata: { secretId: id, name: `${P}direct`, type: "generic" },
      });
      expect(JSON.stringify(audit)).not.toContain(KEY);
    });
  },
);
