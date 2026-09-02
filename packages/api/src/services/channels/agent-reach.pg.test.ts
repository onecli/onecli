import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../../testing/pg-proof.js";

/**
 * The reach-grant lane (space grants: "may the agent answer everyone in this
 * channel?") on REAL PostgreSQL — the two-lane door's laws:
 *
 * - the IDENTITY lane always runs first and is never narrowed by a grant;
 * - the GUEST lane admits same-tenant strangers only under an `approved`
 *   space grant, as `userId: null` turns with a framed, cleaned prefix;
 * - everything else fails CLOSED to today's refusal (pending gets the
 *   softer line), foreign-tenant and unverifiable speakers are ignored;
 * - the invite plants the pending grant + owner-DM cards (claim-before-post
 *   in promptRefs); the lazy re-offer plants it for pre-existing channels;
 * - deciding is governance: the card click's clicker must authorize as a
 *   workspace-access holder; the dashboard door upserts idempotently;
 * - a detach/re-attach never wipes decided grants (keyed by integration).
 *
 * Same harness shape as channels.pg.test.ts: the Slack Web API is a local
 * recording fake behind SLACK_API_BASE_URL; the db is the shared proof
 * database, prefix-fenced.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Dispatch = typeof import("./providers/slack/dispatch");
type Reach = typeof import("./agent-reach-service");
type AgentChannels = typeof import("./agent-channel-service");
type Providers = typeof import("../../providers");

let db: Db;
let dispatch: Dispatch;
let reach: Reach;
let agentChannels: AgentChannels;
let getCrypto: Providers["getCrypto"];

const P = "rchpg-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const OWNER = `${P}owner`;
const MEMBER = `${P}member`;
const TENANT = "T-REACH";

// ── The fake Slack Web API ──────────────────────────────────────────────────

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
        const body = handler
          ? handler(call)
          : { ok: false, error: `test_unscripted_${method}` };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...(body as object) }));
      });
    });
    slackServer.listen(0, "127.0.0.1", () => {
      const { port } = slackServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

/** Script the guest-lane probes: a same-tenant member and an IM open. */
const scriptGuestLane = () => {
  slackHandlers["users.info"] = (call) => ({
    user: {
      id: call.form.get("user"),
      team_id: TENANT,
      name: "dana",
      profile: { display_name: "Dana", email: undefined },
    },
  });
  slackHandlers["conversations.info"] = (call) => ({
    channel: { id: call.form.get("channel"), name: "proj-x" },
  });
  slackHandlers["conversations.open"] = () => ({
    channel: { id: "D-OWNER-IM" },
  });
  slackHandlers["chat.postMessage"] = () => ({
    channel: "D-OWNER-IM",
    ts: "999.111",
  });
  slackHandlers["chat.update"] = () => ({ ts: "999.111" });
};

// ── Seeds (the channels.pg.test.ts shapes, prefix-fenced to THIS suite) ─────

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

/** One integration per test (the (org, provider) unique): find-or-create. */
const seedIntegration = async () =>
  (await db.channelIntegration.findFirst({
    where: { organizationId: ORG, provider: "slack" },
    select: { id: true },
  })) ??
  db.channelIntegration.create({
    data: {
      organizationId: ORG,
      provider: "slack",
      externalId: TENANT,
      name: "Reach Co",
      credentials: null,
      createdByUserId: OWNER,
    },
    select: { id: true },
  });

const seedPresence = async (
  agentId: string,
  integrationId: string,
  options: { credentials?: string | null } = {},
) =>
  db.agentChannel.create({
    data: {
      agentId,
      integrationId,
      provider: "slack",
      externalId: `A-${agentId.slice(0, 8)}`,
      identityRef: "UBOT",
      transport: "socket",
      status: "active",
      credentials:
        options.credentials === undefined
          ? await getCrypto().encrypt(JSON.stringify({ botToken: "xoxb-r" }))
          : options.credentials,
      createdByUserId: OWNER,
    },
    select: { id: true },
  });

const seedChannelAgent = async (suffix: string) => {
  const agentId = await seedAgent(suffix);
  const integration = await seedIntegration();
  const presence = await seedPresence(agentId, integration.id);
  return { agentId, integrationId: integration.id, presenceId: presence.id };
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

const mentionEvent = (
  user: string,
  channel: string,
  ts: string,
  text: string,
) => ({ type: "app_mention", channel, user, text, ts });

const inviteEvent = (inviter: string, channel: string) => ({
  type: "member_joined_channel",
  channel,
  user: "UBOT",
  inviter,
});

/** Detached card posts ride macrotasks (dynamic import + db + fake HTTP);
 * poll with early exit on a condition rather than betting on a fixed number
 * of turns (the one observed flake was this race). Default condition: the
 * card post reached the fake. */
const settleDetached = async (
  done: () => boolean = () => slackCallsFor("chat.postMessage").length > 0,
) => {
  for (let i = 0; i < 40; i += 1) {
    if (done()) {
      // One extra macrotask so the promptRefs write AFTER the post lands.
      await new Promise((resolve) => setTimeout(resolve, 15));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const reset = async () => {
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
  // Grants cascade from agents/integrations; thread links, ingested events
  // and conversations cascade from agents.
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({
    where: { organizationId: ORG },
  });
  await db.policyRuleTarget.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleIdentity.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleV2.deleteMany({
    where: { logicalId: { startsWith: P } },
  });
  await db.secret.deleteMany({ where: { name: { startsWith: P } } });
  slackCalls = [];
  slackHandlers = {};
  scriptGuestLane();
};

beforeAll(async () => {
  if (!PROOF_URL) return;

  const slackUrl = await startSlackFake();
  process.env.DATABASE_URL = PROOF_URL;
  process.env.SLACK_API_BASE_URL = slackUrl;
  process.env.ANTHROPIC_API_BASE_URL = slackUrl;
  process.env.OPENAI_API_BASE_URL = slackUrl;
  // The suite is edition-pinned onprem BEFORE any module import (the
  // channels.pg.test.ts law): CI's ambient EDITION is cloud, whose crypto
  // demands the KMS injection ensureEditionDefaults() does at server boot -
  // module-load edition sniffing would otherwise flip this suite red by
  // scheduling.
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  // Deterministic fake crypto, the channels.pg.test.ts shape.
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  ({ db } = await import("@onecli/db"));
  dispatch = await import("./providers/slack/dispatch");
  reach = await import("./agent-reach-service");
  agentChannels = await import("./agent-channel-service");
  ({ getCrypto } = await import("../../providers"));

  await reset();
  await db.workspaceAccess.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });

  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Reach Workspace", organizationId: ORG },
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
        id: MEMBER,
        email: `${MEMBER}@example.com`,
        externalAuthId: MEMBER,
        name: "Morgan Member",
      },
    ],
  });
  await db.organizationMember.createMany({
    data: [
      {
        organizationId: ORG,
        userId: OWNER,
        userEmail: `${OWNER}@example.com`,
        role: "owner",
      },
      {
        organizationId: ORG,
        userId: MEMBER,
        userEmail: `${MEMBER}@example.com`,
        role: "member",
      },
    ],
  });
  // The notify target: OWNER holds the workspace owner-role binding.
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
  await new Promise<void>((resolve) =>
    slackServer.close(() => resolve()),
  ).catch(() => {});
});

// ── The guest lane ──────────────────────────────────────────────────────────

describe.skipIf(!PROOF_URL)("reach — the guest lane", () => {
  it("a stranger's mention in an ungoverned channel plants the pending grant, DMs the owner, and answers the soft line", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("lazy");
    await linkUser(integrationId, "U-OWNER", OWNER);

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: mentionEvent("U-STRANGER", "C-PROJ", "1.1", "<@UBOT> hi"),
      eventId: "Ev-lazy-1",
    });
    await settleDetached();

    // The waiting line, not the harsh not-linked refusal - and it NAMES
    // the decider and carries the dashboard link, so the room knows who to
    // nudge instead of hearing an ownerless "someone must approve".
    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("refused");
    if (result.outcome.kind !== "refused") throw new Error("unreachable");
    expect(result.outcome.message).toContain("needs to approve me");
    expect(result.outcome.message).toContain(`/agents/${agentId}/channels`);
    // It NAMES the owner (so the room knows who to nudge)...
    expect(result.outcome.message).toContain("Olive Owner");
    // ...but NEVER their email. This line is posted into a channel that by
    // definition may hold non-members - that is the very question being
    // asked - so a contact detail must not ride along.
    expect(result.outcome.message).not.toContain("@example.com");

    // The grant row: pending, labeled, with the owner's card claimed.
    const grant = await db.agentReachGrant.findUniqueOrThrow({
      where: {
        agentId_integrationId_subjectKind_externalRef: {
          agentId,
          integrationId,
          subjectKind: "space",
          externalRef: "C-PROJ",
        },
      },
    });
    expect(grant.state).toBe("pending");
    expect(grant.subjectLabel).toBe("#proj-x");
    expect(grant.promptRefs).toEqual([
      { channel: "D-OWNER-IM", ts: "999.111", userId: OWNER },
    ]);

    // The card went out on the presence's own bot token, to the owner's IM.
    expect(slackCallsFor("conversations.open")).toHaveLength(1);
    expect(slackCallsFor("chat.postMessage")).toHaveLength(1);
    // The button values carry ONLY the opaque grant id.
    const blocks = slackCallsFor("chat.postMessage")[0]?.form.get("blocks");
    expect(blocks).toContain(grant.id);
    expect(blocks).toContain("reach_approve");
    // All THREE settlements are offered - "not everyone" and "not at all"
    // are different answers, and the card must be able to say both.
    expect(blocks).toContain("reach_members");
    expect(blocks).toContain("reach_block");
  });

  it("an APPROVED grant admits the stranger as a guest: userId null, framed cleaned prefix", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("guest");
    await reach.ensureSpaceGrant({
      agentId,
      integrationId,
      provider: "slack",
      externalRef: "C-PROJ",
    });
    await db.agentReachGrant.updateMany({
      where: { agentId },
      data: { state: "approved" },
    });

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: mentionEvent("U-STRANGER", "C-PROJ", "2.1", "<@UBOT> deploy"),
      eventId: "Ev-guest-1",
    });

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("turn");

    const turn = await db.turn.findFirstOrThrow({
      where: { conversation: { agentId } },
    });
    // No platform identity; the framing is OURS, the name is cleaned.
    expect(turn.userId).toBeNull();
    expect(turn.message).toBe("Dana (guest): <@UBOT> deploy");
  });

  it("a FOREIGN-tenant speaker (Slack Connect) is ignored even under an approved grant", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("foreign");
    await reach.ensureSpaceGrant({
      agentId,
      integrationId,
      provider: "slack",
      externalRef: "C-PROJ",
    });
    await db.agentReachGrant.updateMany({
      where: { agentId },
      data: { state: "approved" },
    });
    slackHandlers["users.info"] = (call) => ({
      user: {
        id: call.form.get("user"),
        team_id: "T-ELSEWHERE",
        is_stranger: true,
        name: "mallory",
      },
    });

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: mentionEvent("U-EXT", "C-PROJ", "3.1", "<@UBOT> psst"),
      eventId: "Ev-foreign-1",
    });

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome).toEqual({
      kind: "ignored",
      reason: "guest-foreign-tenant",
    });
    expect(await db.turn.count({ where: { conversation: { agentId } } })).toBe(
      0,
    );
  });

  it("an UNVERIFIABLE speaker (users.info fails) is ignored — fail closed", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("unverif");
    await reach.ensureSpaceGrant({
      agentId,
      integrationId,
      provider: "slack",
      externalRef: "C-PROJ",
    });
    await db.agentReachGrant.updateMany({
      where: { agentId },
      data: { state: "approved" },
    });
    slackHandlers["users.info"] = () => ({
      ok: false,
      error: "user_not_found",
    });

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: mentionEvent("U-GHOST", "C-PROJ", "4.1", "<@UBOT> hello"),
      eventId: "Ev-unverif-1",
    });

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome).toEqual({
      kind: "ignored",
      reason: "guest-unverifiable",
    });
  });

  it("a DENIED grant answers today's refusal and never re-knocks", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("denied");
    await reach.ensureSpaceGrant({
      agentId,
      integrationId,
      provider: "slack",
      externalRef: "C-PROJ",
    });
    await db.agentReachGrant.updateMany({
      where: { agentId },
      data: { state: "denied" },
    });

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: mentionEvent("U-STRANGER", "C-PROJ", "5.1", "<@UBOT> hi"),
      eventId: "Ev-denied-1",
    });
    await settleDetached();

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("refused");
    if (result.outcome.kind !== "refused") throw new Error("unreachable");
    // The identity refusal, not the pending line.
    expect(result.outcome.message).not.toContain("I've asked");
    // No second card: the grant row is the once-fence.
    expect(slackCallsFor("chat.postMessage")).toHaveLength(0);
  });

  it("a SUSPENDED member in a granted channel speaks through the guest lane — documented, deliberate", async () => {
    // Suspension closes the identity lane (org membership check), so in an
    // everyone-channel they fall to the guest lane like any stranger: they
    // can still speak, but as an unattributed guest. Accepted at planning
    // ("this channel is open to everyone in it"); this test is the document.
    const SUSPENDED = `${P}susp`;
    await db.user.upsert({
      where: { id: SUSPENDED },
      create: {
        id: SUSPENDED,
        email: `${SUSPENDED}@example.com`,
        externalAuthId: SUSPENDED,
        name: "Sam Suspended",
      },
      update: {},
    });
    await db.organizationMember.upsert({
      where: {
        organizationId_userId: { organizationId: ORG, userId: SUSPENDED },
      },
      create: {
        organizationId: ORG,
        userId: SUSPENDED,
        userEmail: `${SUSPENDED}@example.com`,
        role: "member",
        status: "suspended",
        suspendedAt: new Date(),
      },
      update: { status: "suspended", suspendedAt: new Date() },
    });
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("susp");
    await linkUser(integrationId, "U-SUSP", SUSPENDED);
    await reach.ensureSpaceGrant({
      agentId,
      integrationId,
      provider: "slack",
      externalRef: "C-PROJ",
    });
    await db.agentReachGrant.updateMany({
      where: { agentId },
      data: { state: "approved" },
    });

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: mentionEvent("U-SUSP", "C-PROJ", "7.1", "<@UBOT> hello"),
      eventId: "Ev-susp-1",
    });

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("turn");
    const turn = await db.turn.findFirstOrThrow({
      where: { conversation: { agentId } },
    });
    // Guest lane, not their platform identity: suspension still cut the
    // identity lane's attribution and everything it carries.
    expect(turn.userId).toBeNull();
    expect(turn.message).toBe("Dana (guest): <@UBOT> hello");
  });

  it("a MEMBER is untouched by the grant machinery: real attribution, no guest framing", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("member");
    await linkUser(integrationId, "U-MEMBER", MEMBER);
    await reach.ensureSpaceGrant({
      agentId,
      integrationId,
      provider: "slack",
      externalRef: "C-PROJ",
    });
    await db.agentReachGrant.updateMany({
      where: { agentId },
      data: { state: "approved" },
    });

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: mentionEvent("U-MEMBER", "C-PROJ", "6.1", "<@UBOT> status"),
      eventId: "Ev-member-1",
    });

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("turn");
    const turn = await db.turn.findFirstOrThrow({
      where: { conversation: { agentId } },
    });
    expect(turn.userId).toBe(MEMBER);
    expect(turn.message).toBe("Morgan Member: <@UBOT> status");
    // The guest lane never ran: no users.info probe was needed.
    expect(slackCallsFor("users.info")).toHaveLength(0);
  });
});

// ── The invite knock ────────────────────────────────────────────────────────

describe.skipIf(!PROOF_URL)("reach — the invite knock", () => {
  it("an authorized invite plants the pending grant and posts the owner card", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("invite");
    await linkUser(integrationId, "U-OWNER", OWNER);

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: inviteEvent("U-OWNER", "C-NEW"),
      eventId: "Ev-invite-1",
    });
    await settleDetached();

    expect(result.kind).toBe("invite");
    if (result.kind !== "invite") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("accept");

    const grant = await db.agentReachGrant.findUniqueOrThrow({
      where: {
        agentId_integrationId_subjectKind_externalRef: {
          agentId,
          integrationId,
          subjectKind: "space",
          externalRef: "C-NEW",
        },
      },
    });
    expect(grant.state).toBe("pending");
    expect(slackCallsFor("chat.postMessage")).toHaveLength(1);
  });

  it("an UNAUTHORIZED inviter still gets the refusal and no grant is planted", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("badinvite");

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: inviteEvent("U-NOBODY", "C-NEW"),
      eventId: "Ev-invite-2",
    });
    await settleDetached();

    expect(result.kind).toBe("invite");
    if (result.kind !== "invite") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("refuse");
    expect(
      await db.agentReachGrant.count({ where: { agentId, integrationId } }),
    ).toBe(0);
  });
});

// ── Deciding ────────────────────────────────────────────────────────────────

describe.skipIf(!PROOF_URL)("reach — deciding", () => {
  const plantPending = async (suffix: string) => {
    const seeded = await seedChannelAgent(suffix);
    const grant = await reach.ensureSpaceGrant({
      agentId: seeded.agentId,
      integrationId: seeded.integrationId,
      provider: "slack",
      externalRef: "C-PROJ",
      subjectLabel: "#proj-x",
    });
    return { ...seeded, grantId: grant.id };
  };

  it("a workspace-linked clicker approves from the card; the decision audits and rewrites posted cards", async () => {
    const { integrationId, presenceId, grantId } = await plantPending("decide");
    await linkUser(integrationId, "U-OWNER", OWNER);
    await db.agentReachGrant.update({
      where: { id: grantId },
      data: {
        promptRefs: [{ channel: "D-OWNER-IM", ts: "999.111", userId: OWNER }],
      },
    });

    const result = await reach.decideReachFromChannel({
      presenceId,
      grantId,
      decision: "approved",
      clickerExternalUserId: "U-OWNER",
    });

    expect(result).toMatchObject({ kind: "decided", state: "approved" });
    const grant = await db.agentReachGrant.findUniqueOrThrow({
      where: { id: grantId },
    });
    expect(grant.state).toBe("approved");
    expect(grant.decidedByUserId).toBe(OWNER);
    // The posted owner card was rewritten.
    expect(slackCallsFor("chat.update")).toHaveLength(1);
    // The audit row names the human.
    const audit = await db.auditLog.findFirstOrThrow({
      where: { userId: OWNER, action: "approve", service: "channel" },
    });
    expect(audit.metadata).toMatchObject({ reachGrantId: grantId });
  });

  it("an UNLINKED clicker is refused — the card being in a DM is not authority", async () => {
    const { presenceId, grantId } = await plantPending("unlinked");
    slackHandlers["users.info"] = () => ({
      user: { id: "U-RANDO", team_id: TENANT, profile: {} },
    });

    const result = await reach.decideReachFromChannel({
      presenceId,
      grantId,
      decision: "approved",
      clickerExternalUserId: "U-RANDO",
    });

    expect(result.kind).toBe("refused");
    const grant = await db.agentReachGrant.findUniqueOrThrow({
      where: { id: grantId },
    });
    expect(grant.state).toBe("pending");
  });

  it("a grant id from ANOTHER tenant answers a hint-free refusal", async () => {
    const first = await plantPending("cross-a");
    // A second agent under its own integration (fresh org row not needed —
    // the fence is (agentId, integrationId), which already differs).
    const second = await seedChannelAgent("cross-b");
    await linkUser(second.integrationId, "U-OWNER", OWNER);

    const result = await reach.decideReachFromChannel({
      presenceId: second.presenceId,
      grantId: first.grantId,
      decision: "approved",
      clickerExternalUserId: "U-OWNER",
    });

    expect(result).toEqual({
      kind: "refused",
      message: "This request no longer exists.",
    });
    expect(
      (
        await db.agentReachGrant.findUniqueOrThrow({
          where: { id: first.grantId },
        })
      ).state,
    ).toBe("pending");
  });

  it("the dashboard door upserts idempotently: approve opens, members_only closes, both audit", async () => {
    const { agentId } = await seedChannelAgent("dash");

    const approved = await reach.setSpaceReachState({
      workspaceId: WORKSPACE,
      agentId,
      provider: "slack",
      externalRef: "C-DASH",
      state: "approved",
      deciderUserId: OWNER,
    });
    expect(approved).toMatchObject({ kind: "decided", state: "approved" });

    const closed = await reach.setSpaceReachState({
      workspaceId: WORKSPACE,
      agentId,
      provider: "slack",
      externalRef: "C-DASH",
      state: "members_only",
      deciderUserId: OWNER,
    });
    expect(closed).toMatchObject({ kind: "decided", state: "members_only" });

    // Same outcome twice = already_settled, not an error.
    const again = await reach.setSpaceReachState({
      workspaceId: WORKSPACE,
      agentId,
      provider: "slack",
      externalRef: "C-DASH",
      state: "members_only",
      deciderUserId: OWNER,
    });
    expect(again).toEqual({ kind: "already_settled" });

    // The dashboard is an explicit management door: it may RE-OPEN a
    // settled space - unlike a stale card click.
    const reopened = await reach.setSpaceReachState({
      workspaceId: WORKSPACE,
      agentId,
      provider: "slack",
      externalRef: "C-DASH",
      state: "approved",
      deciderUserId: OWNER,
    });
    expect(reopened).toMatchObject({ kind: "decided", state: "approved" });
  });

  it("a card click on a SETTLED grant answers already_settled - it never re-flips", async () => {
    const { integrationId, presenceId, grantId } =
      await plantPending("stale-card");
    await linkUser(integrationId, "U-OWNER", OWNER);
    await db.agentReachGrant.update({
      where: { id: grantId },
      data: { state: "denied" },
    });

    const result = await reach.decideReachFromChannel({
      presenceId,
      grantId,
      decision: "approved",
      clickerExternalUserId: "U-OWNER",
    });

    expect(result).toEqual({ kind: "already_settled" });
    expect(
      (
        await db.agentReachGrant.findUniqueOrThrow({
          where: { id: grantId },
        })
      ).state,
    ).toBe("denied");
  });

  it("the dashboard door fences agent↔workspace coherence", async () => {
    const { agentId } = await seedChannelAgent("fence");
    await expect(
      reach.setSpaceReachState({
        workspaceId: "some-other-workspace",
        agentId,
        provider: "slack",
        externalRef: "C-X",
        state: "approved",
        deciderUserId: OWNER,
      }),
    ).rejects.toThrow("Agent not found");
  });
});

// ── Leave cleanup & dismiss ─────────────────────────────────────────────────

describe.skipIf(!PROOF_URL)("reach — leave cleanup and dismiss", () => {
  const inviteEvt = (channel: string) => ({
    type: "member_joined_channel",
    channel,
    user: "UBOT",
    inviter: "U-OWNER",
  });
  const leaveEvt = (channel: string) => ({
    type: "member_left_channel",
    channel,
    user: "UBOT",
  });

  it("the bot's removal deletes the channel's thread links, parks the grant as left, and settles cards", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("leave");
    await linkUser(integrationId, "U-OWNER", OWNER);

    // Invite plants the pending grant + owner card.
    await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: inviteEvt("C-GONE"),
      eventId: "Ev-leave-1",
    });
    await settleDetached();
    // A live thread in that channel plus one in ANOTHER channel (the
    // surviving control).
    const conversation = await db.conversation.create({
      data: { agentId, source: "slack", externalRef: "C-GONE:1.1" },
      select: { id: true },
    });
    await db.channelThreadLink.create({
      data: {
        agentChannelId: presenceId,
        conversationId: conversation.id,
        externalThreadId: "C-GONE:1.1",
        kind: "group",
      },
    });
    const other = await db.conversation.create({
      data: { agentId, source: "slack", externalRef: "C-STAYS:2.2" },
      select: { id: true },
    });
    await db.channelThreadLink.create({
      data: {
        agentChannelId: presenceId,
        conversationId: other.id,
        externalThreadId: "C-STAYS:2.2",
        kind: "group",
      },
    });

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: leaveEvt("C-GONE"),
      eventId: "Ev-leave-2",
    });
    expect(result).toEqual({
      kind: "ignored",
      reason: "left-channel-cleaned",
    });

    // The channel's links are gone; the other channel's survive.
    const links = await db.channelThreadLink.findMany({
      where: { agentChannelId: presenceId },
      select: { externalThreadId: true },
    });
    expect(links).toEqual([{ externalThreadId: "C-STAYS:2.2" }]);

    // The grant parked as left; the pending owner card was rewritten.
    const grant = await db.agentReachGrant.findFirstOrThrow({
      where: { agentId, externalRef: "C-GONE" },
    });
    expect(grant.state).toBe("left");
    expect(slackCallsFor("chat.update").length).toBeGreaterThan(0);

    // Left rows are hidden from the projection.
    expect(await reach.listSpaceGrants(agentId, "slack")).toEqual([]);
  });

  it("teammates leaving are noise — only the bot's own departure cleans", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("othr-leave");
    await reach.ensureSpaceGrant({
      agentId,
      integrationId,
      provider: "slack",
      externalRef: "C-KEEP2",
    });

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: {
        type: "member_left_channel",
        channel: "C-KEEP2",
        user: "U-SOMEONE",
      },
      eventId: "Ev-leave-3",
    });
    expect(result).toEqual({ kind: "ignored", reason: "someone-else-left" });
    expect(
      (
        await db.agentReachGrant.findFirstOrThrow({
          where: { agentId, externalRef: "C-KEEP2" },
        })
      ).state,
    ).toBe("pending");
  });

  it("a re-invite after a leave RE-KNOCKS: the left grant re-arms pending and cards go out again", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("rearm");
    await linkUser(integrationId, "U-OWNER", OWNER);
    // Approved, then the bot is removed.
    await reach.ensureSpaceGrant({
      agentId,
      integrationId,
      provider: "slack",
      externalRef: "C-BACK",
    });
    await db.agentReachGrant.updateMany({
      where: { agentId },
      data: { state: "approved" },
    });
    await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: leaveEvt("C-BACK"),
      eventId: "Ev-rearm-1",
    });

    // Re-invite: the OLD approval is context, not authority — re-knock.
    await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: inviteEvt("C-BACK"),
      eventId: "Ev-rearm-2",
    });
    await settleDetached();

    const grant = await db.agentReachGrant.findFirstOrThrow({
      where: { agentId, externalRef: "C-BACK" },
    });
    expect(grant.state).toBe("pending");
    expect(grant.decidedByUserId).toBeNull();
    // A fresh owner card went out for the re-knock.
    expect(slackCallsFor("chat.postMessage").length).toBeGreaterThan(0);
  });

  it("DISMISS forgets the channel whatever the state: grant + links deleted, the next stranger re-knocks", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("dismiss");
    await linkUser(integrationId, "U-OWNER", OWNER);
    await reach.ensureSpaceGrant({
      agentId,
      integrationId,
      provider: "slack",
      externalRef: "C-PROJ",
    });
    await db.agentReachGrant.updateMany({
      where: { agentId },
      data: { state: "approved" },
    });
    const conversation = await db.conversation.create({
      data: { agentId, source: "slack", externalRef: "C-PROJ:9.9" },
      select: { id: true },
    });
    await db.channelThreadLink.create({
      data: {
        agentChannelId: presenceId,
        conversationId: conversation.id,
        externalThreadId: "C-PROJ:9.9",
        kind: "group",
      },
    });

    const result = await reach.dismissReachRow({
      workspaceId: WORKSPACE,
      agentId,
      provider: "slack",
      externalRef: "C-PROJ",
      dismissedByUserId: OWNER,
    });
    expect(result).toEqual({ removedGrant: true, removedLinks: 1 });
    expect(await db.agentReachGrant.count({ where: { agentId } })).toBe(0);

    // The next stranger message re-knocks fresh (the lazy re-offer).
    const knock = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: mentionEvent("U-STRANGER", "C-PROJ", "10.1", "<@UBOT> hello"),
      eventId: "Ev-dismiss-1",
    });
    await settleDetached();
    expect(knock.kind).toBe("message");
    if (knock.kind !== "message") throw new Error("unreachable");
    expect(knock.outcome.kind).toBe("refused");
    const regrown = await db.agentReachGrant.findFirstOrThrow({
      where: { agentId, externalRef: "C-PROJ" },
    });
    expect(regrown.state).toBe("pending");
  });

  it("dismiss fences agent↔workspace coherence", async () => {
    const { agentId } = await seedChannelAgent("dismiss-fence");
    await expect(
      reach.dismissReachRow({
        workspaceId: "some-other-workspace",
        agentId,
        provider: "slack",
        externalRef: "C-X",
        dismissedByUserId: OWNER,
      }),
    ).rejects.toThrow("Agent not found");
  });
});

// ── Durability & the view ───────────────────────────────────────────────────

describe.skipIf(!PROOF_URL)("reach — durability and the view", () => {
  it("a detach/re-attach keeps the decided grant (keyed by integration, not presence)", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("durable");
    await reach.ensureSpaceGrant({
      agentId,
      integrationId,
      provider: "slack",
      externalRef: "C-KEEP",
    });
    await db.agentReachGrant.updateMany({
      where: { agentId },
      data: { state: "approved" },
    });

    await db.agentChannel.delete({ where: { id: presenceId } });
    await seedPresence(agentId, integrationId);

    expect(
      await reach.resolveSpaceReach({
        agentId,
        integrationId,
        externalRef: "C-KEEP",
      }),
    ).toBe("approved");
  });

  it("the channels view carries grant rows AND live threads' spaces as pending", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("view");
    await reach.ensureSpaceGrant({
      agentId,
      integrationId,
      provider: "slack",
      externalRef: "C-GRANTED",
      subjectLabel: "#granted",
    });
    // A live group thread in a channel with no grant row.
    const conversation = await db.conversation.create({
      data: {
        agentId,
        source: "slack",
        externalRef: "C-PLAIN:1.1",
      },
      select: { id: true },
    });
    await db.channelThreadLink.create({
      data: {
        agentChannelId: presenceId,
        conversationId: conversation.id,
        externalThreadId: "C-PLAIN:1.1",
        kind: "group",
      },
    });

    const view = await agentChannels.getAgentChannels(WORKSPACE, agentId);
    const spaces = view.presences[0]?.spaces ?? [];
    expect(spaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalRef: "C-GRANTED",
          label: "#granted",
          state: "pending",
        }),
        // An unsettled channel reads as `pending`, never as a silent
        // "members_only": under the precondition model nobody has decided
        // it yet, and the row must say so.
        expect.objectContaining({
          externalRef: "C-PLAIN",
          state: "pending",
        }),
      ]),
    );
  });
});
