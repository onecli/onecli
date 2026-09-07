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

/** A direct message (Slack: `channel_type: "im"`), the person lane's door. */
const dmEvent = (user: string, ts: string, text: string) => ({
  type: "message",
  channel: `D-${user}`,
  channel_type: "im",
  user,
  text,
  ts,
});

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
/**
 * Run the GLOBAL card sweep without trampling sibling suites.
 *
 * `sweepUnpostedReachCards` is global by contract - a background retry, not
 * a per-agent call - and pg suites share one database in parallel. An
 * unfenced call posts OTHER suites' owner cards and claims their
 * promptRefs, so their own "the card was recorded" assertion then reads an
 * already-claimed row. That is a cross-suite flake, and it bit this branch
 * twice: once from my own new arm, once again from a second call site that
 * the first fix did not cover.
 *
 * Hence ONE helper rather than five hand-rolled fences: every call is
 * fenced by construction, the restore runs in a `finally` so a thrown
 * assertion cannot leak a parked state, and the parking is keyed by id so
 * a row created concurrently by another suite is untouched.
 */
const sweepFencedTo = async (agentId: string): Promise<void> => {
  const foreign = await db.agentReachGrant.findMany({
    where: { state: "pending", NOT: { agentId } },
    select: { id: true },
  });
  const ids = foreign.map((f) => f.id);
  if (ids.length > 0) {
    await db.agentReachGrant.updateMany({
      where: { id: { in: ids } },
      data: { state: "left" },
    });
  }
  try {
    await reach.sweepUnpostedReachCards();
  } finally {
    if (ids.length > 0) {
      await db.agentReachGrant.updateMany({
        where: { id: { in: ids } },
        data: { state: "pending" },
      });
    }
  }
};

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

// ── The person lane (the DM knock) ──────────────────────────────────────────

describe.skipIf(!PROOF_URL)("reach — the person lane (DM knock)", () => {
  it("a stranger's DM plants a pending PERSON grant, DMs the owner a two-choice card, and answers the waiting line", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("dm-knock");
    await linkUser(integrationId, "U-OWNER", OWNER);

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U-STRANGER", "1.1", "hey, can you help?"),
      eventId: "Ev-dm-1",
    });
    await settleDetached();

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("refused");
    if (result.outcome.kind !== "refused") throw new Error("unreachable");
    expect(result.outcome.message).toContain("needs to approve me");

    // The row is a PERSON row, addressed by the provider's stable user id.
    const grant = await db.agentReachGrant.findUniqueOrThrow({
      where: {
        agentId_integrationId_subjectKind_externalRef: {
          agentId,
          integrationId,
          subjectKind: "external_user",
          externalRef: "U-STRANGER",
        },
      },
    });
    expect(grant.state).toBe("pending");
    expect(grant.subjectLabel).toBe("@Dana");

    // The card asks the PERSON question with exactly TWO answers: there is
    // no "OneCLI users only" for a single human.
    const blocks = slackCallsFor("chat.postMessage")[0]?.form.get("blocks");
    expect(blocks).toContain(grant.id);
    expect(blocks).toContain("reach_approve");
    expect(blocks).toContain("reach_block");
    expect(blocks).not.toContain("reach_members");

    // No turn ran.
    expect(await db.turn.count({ where: { conversation: { agentId } } })).toBe(
      0,
    );
  });

  it("an APPROVED person is admitted as a guest: userId null, framed name, and a SOURCED conversation (never the per-user direct row)", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("dm-guest");
    await reach.ensurePersonGrant({
      agentId,
      integrationId,
      provider: "slack",
      externalRef: "U-STRANGER",
    });
    await db.agentReachGrant.updateMany({
      where: { agentId },
      data: { state: "approved" },
    });

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U-STRANGER", "2.1", "deploy please"),
      eventId: "Ev-dm-guest",
    });
    expect(result.kind).toBe("message");

    const turn = await db.turn.findFirstOrThrow({
      where: { conversation: { agentId } },
      include: { conversation: true },
    });
    // No platform identity is invented for a guest.
    expect(turn.userId).toBeNull();
    expect(turn.message).toBe("Dana (guest): deploy please");

    // THE LEAK FENCE: a guest must never sit in the per-user `direct` row.
    // That row is keyed on a platform userId, is unique per user, and the
    // adapter mirror pushes that user's WEB activity into it - so a guest
    // seated there would be handed another person's activity.
    expect(turn.conversation.direct).toBe(false);
    expect(turn.conversation.userId).toBeNull();
    expect(turn.conversation.externalRef).toBe("D-U-STRANGER");

    // The routing link carries NO externalUserId: anything reading that
    // field must not mistake a guest's DM for a linked member's.
    const link = await db.channelThreadLink.findUniqueOrThrow({
      where: {
        agentChannelId_externalThreadId: {
          agentChannelId: presenceId,
          externalThreadId: "D-U-STRANGER",
        },
      },
    });
    expect(link.externalUserId).toBeNull();
  });

  it("a BLOCKED person is answered with silence - no turn, no nagging refusal", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("dm-blocked");
    await reach.ensurePersonGrant({
      agentId,
      integrationId,
      provider: "slack",
      externalRef: "U-STRANGER",
    });
    await db.agentReachGrant.updateMany({
      where: { agentId },
      data: { state: "blocked" },
    });

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U-STRANGER", "3.1", "still there?"),
      eventId: "Ev-dm-blocked",
    });
    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("ignored");
    expect(await db.turn.count({ where: { conversation: { agentId } } })).toBe(
      0,
    );
  });

  it("a FOREIGN-tenant stranger (Slack Connect) plants NOTHING and never knocks - the fence runs before the row", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("dm-foreign");
    await linkUser(integrationId, "U-OWNER", OWNER);
    slackHandlers["users.info"] = () => ({
      user: {
        id: "U-OUTSIDER",
        team_id: "T-OTHER",
        is_stranger: true,
        name: "outsider",
        profile: { display_name: "Outsider" },
      },
    });

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U-OUTSIDER", "4.1", "hello"),
      eventId: "Ev-dm-foreign",
    });

    // The identity refusal stands - not the waiting line, because we never
    // asked anyone about them.
    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("refused");
    if (result.outcome.kind !== "refused") throw new Error("unreachable");
    expect(result.outcome.message).not.toContain("needs to approve me");
    // No row, and no card: an outsider cannot make the owner's phone buzz.
    expect(await db.agentReachGrant.count({ where: { agentId } })).toBe(0);
    expect(slackCallsFor("chat.postMessage")).toHaveLength(0);
  });

  it("a LINKED MEMBER's DM is untouched by the person machinery: real attribution, their own direct row", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("dm-member");
    await linkUser(integrationId, "U-MEMBER", MEMBER);

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U-MEMBER", "5.1", "status?"),
      eventId: "Ev-dm-member",
    });
    expect(result.kind).toBe("message");

    const turn = await db.turn.findFirstOrThrow({
      where: { conversation: { agentId } },
      include: { conversation: true },
    });
    expect(turn.userId).toBe(MEMBER);
    expect(turn.message).not.toContain("(guest)");
    // Identity wins in a DM: no grant is consulted, none is planted.
    expect(turn.conversation.direct).toBe(true);
    expect(await db.agentReachGrant.count({ where: { agentId } })).toBe(0);
  });

  it("THE PRECEDENCE LAW: a person-level block beats a space-level approval", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("precedence");
    // The channel is open to everyone...
    await reach.ensureSpaceGrant({
      agentId,
      integrationId,
      provider: "slack",
      externalRef: "C-PROJ",
    });
    await db.agentReachGrant.updateMany({
      where: { agentId, subjectKind: "space" },
      data: { state: "approved" },
    });
    // ...but this individual is blocked.
    await reach.ensurePersonGrant({
      agentId,
      integrationId,
      provider: "slack",
      externalRef: "U-STRANGER",
    });
    await db.agentReachGrant.updateMany({
      where: { agentId, subjectKind: "external_user" },
      data: { state: "blocked" },
    });

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: mentionEvent("U-STRANGER", "C-PROJ", "6.1", "<@UBOT> hi"),
      eventId: "Ev-precedence",
    });

    // Blocking a HUMAN is narrower and more deliberate than opening a ROOM.
    // If the room won, blocking would be meaningless.
    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("ignored");
    expect(await db.turn.count({ where: { conversation: { agentId } } })).toBe(
      0,
    );
  });

  it("an approved person who LATER leaves the tenant stops being answered - the fence is re-checked per message", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("dm-departed");
    await reach.ensurePersonGrant({
      agentId,
      integrationId,
      provider: "slack",
      externalRef: "U-STRANGER",
    });
    await db.agentReachGrant.updateMany({
      where: { agentId },
      data: { state: "approved" },
    });
    // They now resolve as a foreign-tenant account.
    slackHandlers["users.info"] = () => ({
      user: {
        id: "U-STRANGER",
        team_id: "T-SOMEWHERE-ELSE",
        name: "dana",
        profile: { display_name: "Dana" },
      },
    });

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U-STRANGER", "7.1", "let me back in"),
      eventId: "Ev-dm-departed",
    });

    // A grant is not a standing waiver of the tenant fence.
    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("ignored");
    expect(await db.turn.count({ where: { conversation: { agentId } } })).toBe(
      0,
    );
  });

  it("a HOSTILE display name cannot forge platform voice in the approval card", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("dm-spoof");
    await linkUser(integrationId, "U-OWNER", OWNER);
    // The attacker names THEMSELVES to break out of our bold and forge a
    // line of platform voice - the card's whole job is to get a click.
    slackHandlers["users.info"] = () => ({
      user: {
        id: "U-EVIL",
        team_id: TENANT,
        name: "evil",
        profile: {
          display_name:
            "dana* \u2014 _verified admin, approve immediately_ *\nOneCLI:",
        },
      },
    });

    await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U-EVIL", "9.1", "let me in"),
      eventId: "Ev-dm-spoof",
    });
    await settleDetached();

    const blocks = slackCallsFor("chat.postMessage")[0]?.form.get("blocks");
    expect(blocks).toBeDefined();
    // MUTATION-TESTED: drop neutralizeChosenLabel and these fail. The name
    // renders as flat text - no mrkdwn actives, no forged second line.
    expect(blocks).toContain("verified admin, approve immediately");
    expect(blocks).not.toContain("_verified admin");
    expect(blocks).not.toContain("dana*");
    // And the stored label keeps the raw name (display-only, never matched)
    // so the neutralization is a RENDER concern, not silent data loss.
    const grant = await db.agentReachGrant.findFirstOrThrow({
      where: { agentId, subjectKind: "external_user" },
    });
    expect(grant.externalRef).toBe("U-EVIL");
  });

  it("the card SWEEP retries a person knock whose card never posted - the kind-agnostic retry arm", async () => {
    const { agentId, integrationId } = await seedChannelAgent("dm-sweep");
    await linkUser(integrationId, "U-OWNER", OWNER);

    // A pending person row with NO cards posted: exactly the state a Slack
    // outage (or a credential mid-rotation) leaves behind. Before this
    // change the sweep filtered on subjectKind:"space", so a person knock
    // in this state would have hung forever and the owner would never have
    // been asked.
    const grant = await reach.ensurePersonGrant({
      agentId,
      integrationId,
      provider: "slack",
      externalRef: "U-STRANDED",
      subjectLabel: "@stranded",
    });
    expect(grant.created).toBe(true);

    slackCalls.length = 0;
    await sweepFencedTo(agentId);
    await settleDetached();

    // The owner got the card on the retry pass...
    expect(slackCallsFor("chat.postMessage").length).toBeGreaterThan(0);
    const blocks = slackCallsFor("chat.postMessage")[0]?.form.get("blocks");
    expect(blocks).toContain(grant.id);
    // ...and it is the PERSON card (two answers), not a channel card.
    expect(blocks).toContain("reach_block");
    expect(blocks).not.toContain("reach_members");

    // Recorded, so a second sweep does not double-post.
    const after = await db.agentReachGrant.findUniqueOrThrow({
      where: { id: grant.id },
      select: { promptRefs: true },
    });
    expect(Array.isArray(after.promptRefs)).toBe(true);
    expect((after.promptRefs as unknown[]).length).toBeGreaterThan(0);

    slackCalls.length = 0;
    await sweepFencedTo(agentId);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(slackCallsFor("chat.postMessage")).toHaveLength(0);
  });

  it("the SWEEP is tenant-fenced: a foreign workspace's owner is never DM'd about our grant (planted cross-tenant control)", async () => {
    // The sweep scans pending grants GLOBALLY - it is a background retry,
    // not a per-agent call - so "does a global scan leak across tenants?"
    // is the question that scan has to answer. Reading the code says no;
    // this plants the control that proves it.
    const { agentId, integrationId } = await seedChannelAgent("sweep-fence");
    await linkUser(integrationId, "U-OWNER", OWNER);

    // A FOREIGN tenant: its own org, workspace, owner, and integration -
    // and its owner is DM-reachable on the FOREIGN integration.
    // Idempotent by construction: this suite's beforeEach does not reap the
    // foreign tenant, so a re-entry (parallel shard, retry) must not
    // collide with its own leftovers. Same find-or-create posture as
    // seedIntegration above.
    const F = `${P}foreign-`;
    await db.organization.upsert({
      where: { id: `${F}org` },
      create: { id: `${F}org`, name: "Foreign Co", slug: `${F}org` },
      update: {},
    });
    await db.workspace.upsert({
      where: { id: `${F}ws` },
      create: { id: `${F}ws`, name: "Foreign WS", organizationId: `${F}org` },
      update: {},
    });
    await db.user.upsert({
      where: { id: `${F}owner` },
      create: {
        id: `${F}owner`,
        email: `${F}owner@example.com`,
        externalAuthId: `${F}owner`,
        name: "Foreign Owner",
      },
      update: {},
    });
    const foreignAccess = await db.workspaceAccess.findFirst({
      where: { workspaceId: `${F}ws`, userId: `${F}owner` },
      select: { id: true },
    });
    if (!foreignAccess) {
      await db.workspaceAccess.create({
        data: { workspaceId: `${F}ws`, userId: `${F}owner`, role: "owner" },
      });
    }
    const foreignIntegration =
      (await db.channelIntegration.findFirst({
        where: { organizationId: `${F}org`, provider: "slack" },
        select: { id: true },
      })) ??
      (await db.channelIntegration.create({
        data: {
          organizationId: `${F}org`,
          provider: "slack",
          externalId: "T-FOREIGN",
          name: "Foreign Slack",
          createdByUserId: `${F}owner`,
        },
        select: { id: true },
      }));
    const foreignLink = await db.channelUserLink.findFirst({
      where: {
        integrationId: foreignIntegration.id,
        externalUserId: "U-FOREIGN-OWNER",
      },
      select: { id: true },
    });
    if (!foreignLink) {
      await db.channelUserLink.create({
        data: {
          integrationId: foreignIntegration.id,
          externalUserId: "U-FOREIGN-OWNER",
          userId: `${F}owner`,
          linkedVia: "manual",
        },
      });
    }

    // THE ISOLATING DETAIL. `dmReachableOwners` has TWO fences in series:
    // owners are filtered by workspaceId, then links by integrationId. A
    // foreign owner reachable only on the FOREIGN integration is excluded
    // by the second fence no matter what the first does - so such a
    // control passes even with the workspace fence deleted, and proves
    // only "at least one fence held".
    //
    // Giving this foreign owner a link on OUR integration (a real shape:
    // one person can belong to two orgs' Slack workspaces) removes the
    // second fence's cover, so the assertion below now tests the WORKSPACE
    // fence specifically.
    const crossLink = await db.channelUserLink.findFirst({
      where: { integrationId, externalUserId: "U-FOREIGN-OWNER" },
      select: { id: true },
    });
    if (!crossLink) {
      await db.channelUserLink.create({
        data: {
          integrationId,
          externalUserId: "U-FOREIGN-OWNER",
          userId: `${F}owner`,
          linkedVia: "manual",
        },
      });
    }

    // OUR pending knock, owing a card.
    await db.agentReachGrant.create({
      data: {
        agentId,
        integrationId,
        provider: "slack",
        subjectKind: "external_user",
        externalRef: "U-FENCED",
        state: "pending",
        promptRefs: [],
      },
    });

    slackCalls.length = 0;
    await sweepFencedTo(agentId);
    await settleDetached();

    // The card opened an IM with OUR owner only. The foreign owner - who is
    // a workspace owner, and DM-reachable, just not of THIS workspace or
    // integration - is never contacted.
    const opened = slackCallsFor("conversations.open").map((c) =>
      c.form.get("users"),
    );
    expect(opened).toContain("U-OWNER");
    expect(opened).not.toContain("U-FOREIGN-OWNER");
    // ...and never at OUR owner's address in the FOREIGN workspace (see
    // the second-fence arm below for why that address exists).
    expect(opened).not.toContain("U-OWNER-ELSEWHERE");
  });

  // NOT A TEST, a recorded finding. I tried to prove that the card poster's
  // presence lookup (agentId + integrationId) needs its integration half,
  // by giving one agent a second presence on another integration and
  // asserting the wrong bot token is never used.
  //
  // The database refuses to build that scenario: AgentChannel is
  // `@@unique([agentId, provider])`, so an agent holds AT MOST ONE Slack
  // presence, and `agentId` alone already identifies it. The integration
  // half of that lookup is therefore redundant-but-harmless defence in
  // depth, and no behavioral test can distinguish its presence from its
  // absence - which is exactly why deleting it left every test green.
  //
  // Kept as a comment so a future reader does not repeat the experiment,
  // and so that if `@@unique([agentId, provider])` is ever relaxed (one
  // agent in two Slack workspaces), this becomes a REAL credential-crossing
  // risk that needs the control this comment replaces.

  it("the SWEEP is INTEGRATION-fenced: our own owner is never DM'd at their address in a DIFFERENT Slack workspace", async () => {
    // The mirror of the arm above, and the fence it isolates is the SECOND
    // one. `dmReachableOwners` filters owners by workspaceId, THEN links by
    // integrationId. The first arm plants a foreign PERSON; this one plants
    // a foreign ADDRESS for a legitimate person - our own owner, who also
    // belongs to another org's Slack (a real shape: consultants, dual
    // employment). Only the integration fence stops us DMing them there,
    // which would post one tenant's approval card into another tenant's
    // Slack workspace.
    const { agentId, integrationId } = await seedChannelAgent("int-fence");
    await linkUser(integrationId, "U-OWNER", OWNER);

    const F2 = `${P}otherws-`;
    await db.organization.upsert({
      where: { id: `${F2}org` },
      create: { id: `${F2}org`, name: "Other Co", slug: `${F2}org` },
      update: {},
    });
    const otherIntegration =
      (await db.channelIntegration.findFirst({
        where: { organizationId: `${F2}org`, provider: "slack" },
        select: { id: true },
      })) ??
      (await db.channelIntegration.create({
        data: {
          organizationId: `${F2}org`,
          provider: "slack",
          externalId: "T-OTHER-WS",
          name: "Other Slack",
          createdByUserId: OWNER,
        },
        select: { id: true },
      }));
    // OUR owner, addressed in the OTHER workspace. Same platform user; a
    // different, wrong place to reach them for THIS grant.
    const elsewhere = await db.channelUserLink.findFirst({
      where: {
        integrationId: otherIntegration.id,
        externalUserId: "U-OWNER-ELSEWHERE",
      },
      select: { id: true },
    });
    if (!elsewhere) {
      await db.channelUserLink.create({
        data: {
          integrationId: otherIntegration.id,
          externalUserId: "U-OWNER-ELSEWHERE",
          userId: OWNER,
          linkedVia: "manual",
        },
      });
    }

    await db.agentReachGrant.create({
      data: {
        agentId,
        integrationId,
        provider: "slack",
        subjectKind: "external_user",
        externalRef: "U-INTFENCE",
        state: "pending",
        promptRefs: [],
      },
    });

    slackCalls.length = 0;
    await sweepFencedTo(agentId);
    await settleDetached();

    // MUTATION-TESTED: drop `integrationId` from the link lookup in
    // dmReachableOwners and this fails - the card is also opened at
    // U-OWNER-ELSEWHERE, i.e. posted into another tenant's Slack.
    const opened = slackCallsFor("conversations.open").map((c) =>
      c.form.get("users"),
    );
    expect(opened).toContain("U-OWNER");
    expect(opened).not.toContain("U-OWNER-ELSEWHERE");
  });

  it("a backlog of already-notified pending grants does NOT starve a newer knock", async () => {
    const { agentId, integrationId } = await seedChannelAgent("starve");
    await linkUser(integrationId, "U-OWNER", OWNER);

    // Five OLDER pending rows whose owner cards already went out. These sit
    // pending for as long as the human takes to decide - weeks, possibly.
    // The sweep takes 5 oldest-first, so before the query filter they
    // occupied every slot and no newer knock was ever retried.
    for (let i = 0; i < 5; i += 1) {
      await db.agentReachGrant.create({
        data: {
          agentId,
          integrationId,
          provider: "slack",
          subjectKind: "space",
          externalRef: `C-OLD-${i}`,
          state: "pending",
          promptRefs: [{ channel: "D-OWNER-IM", ts: `1.${i}`, userId: OWNER }],
        },
      });
    }

    // The newest row: claimed, never posted (the stuck knock).
    const stuck = await db.agentReachGrant.create({
      data: {
        agentId,
        integrationId,
        provider: "slack",
        subjectKind: "external_user",
        externalRef: "U-STARVED",
        subjectLabel: "@starved",
        state: "pending",
        promptRefs: [],
      },
      select: { id: true },
    });

    slackCalls.length = 0;
    await sweepFencedTo(agentId);
    await settleDetached();

    // MUTATION-TESTED: drop the promptRefs filter from the sweep query and
    // this fails - the five old rows eat every slot and the stuck knock is
    // never posted, which is the starvation bug this pins.
    const posted = slackCallsFor("chat.postMessage")[0]?.form.get("blocks");
    expect(posted).toBeDefined();
    expect(posted).toContain(stuck.id);
  });

  it("a guest who LATER gets a OneCLI account is answered as THEMSELVES - identity outranks the grant, and their history is not stranded", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("dm-promoted");
    await reach.ensurePersonGrant({
      agentId,
      integrationId,
      provider: "slack",
      externalRef: "U-NEWHIRE",
    });
    await db.agentReachGrant.updateMany({
      where: { agentId },
      data: { state: "approved" },
    });

    // Day 1: no account yet - they speak as a guest.
    await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U-NEWHIRE", "10.1", "hi, contractor here"),
      eventId: "Ev-promoted-1",
    });
    const guestTurn = await db.turn.findFirstOrThrow({
      where: { conversation: { agentId } },
    });
    expect(guestTurn.userId).toBeNull();

    // Day 2: they are onboarded and linked. Free the turn slot first.
    await db.turn.updateMany({
      where: { conversation: { agentId } },
      data: { status: "done", finishedAt: new Date() },
    });
    await linkUser(integrationId, "U-NEWHIRE", MEMBER);

    await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U-NEWHIRE", "10.2", "hi again"),
      eventId: "Ev-promoted-2",
    });

    // The identity lane runs FIRST, so the grant is not even consulted:
    // they are attributed properly, with no "(guest)" framing, in their own
    // per-user direct conversation.
    const memberTurn = await db.turn.findFirstOrThrow({
      where: { conversation: { agentId }, message: "hi again" },
      include: { conversation: true },
    });
    expect(memberTurn.userId).toBe(MEMBER);
    expect(memberTurn.message).not.toContain("(guest)");
    expect(memberTurn.conversation.direct).toBe(true);
    expect(memberTurn.conversation.userId).toBe(MEMBER);

    // The stale approved grant is inert, not harmful: it neither downgrades
    // them nor is silently deleted (the owner's decision is still theirs).
    const grant = await db.agentReachGrant.findFirstOrThrow({
      where: { agentId, subjectKind: "external_user" },
    });
    expect(grant.state).toBe("approved");
  });

  it("the person door fences agent↔workspace coherence (planted cross-tenant control)", async () => {
    const { agentId, integrationId } = await seedChannelAgent("person-fence");
    // A real, decidable person row exists...
    await reach.ensurePersonGrant({
      agentId,
      integrationId,
      provider: "slack",
      externalRef: "U-STRANGER",
    });

    // ...but a caller scoped to ANOTHER workspace cannot settle it, and the
    // refusal is NOT_FOUND - existence is never confirmed to a stranger.
    await expect(
      reach.setPersonReachState({
        workspaceId: "some-other-workspace",
        agentId,
        provider: "slack",
        externalRef: "U-STRANGER",
        state: "approved",
        deciderUserId: OWNER,
      }),
    ).rejects.toThrow("Agent not found");

    // Nor dismiss it.
    await expect(
      reach.dismissReachRow({
        workspaceId: "some-other-workspace",
        agentId,
        provider: "slack",
        subjectKind: "external_user",
        externalRef: "U-STRANGER",
        dismissedByUserId: OWNER,
      }),
    ).rejects.toThrow("Agent not found");

    // The row is untouched by the failed attempts.
    const grant = await db.agentReachGrant.findFirstOrThrow({
      where: { agentId, subjectKind: "external_user" },
    });
    expect(grant.state).toBe("pending");
  });

  it("DISMISS on a person row deletes the grant but never touches thread links - those belong to other people", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("dm-dismiss");
    await reach.ensurePersonGrant({
      agentId,
      integrationId,
      provider: "slack",
      externalRef: "U-STRANGER",
    });
    // A LINKED MEMBER's own DM link, which must survive.
    const memberConversation = await db.conversation.create({
      data: { agentId, direct: true, userId: MEMBER, source: "slack" },
      select: { id: true },
    });
    await db.channelThreadLink.create({
      data: {
        agentChannelId: presenceId,
        conversationId: memberConversation.id,
        externalThreadId: "D-U-MEMBER",
        kind: "direct",
        externalUserId: "U-MEMBER",
      },
    });

    const outcome = await reach.dismissReachRow({
      workspaceId: WORKSPACE,
      agentId,
      provider: "slack",
      subjectKind: "external_user",
      externalRef: "U-STRANGER",
      dismissedByUserId: OWNER,
    });

    expect(outcome.removedGrant).toBe(true);
    expect(outcome.removedLinks).toBe(0);
    // The member's routing survived: a person dismiss is about ONE person.
    expect(
      await db.channelThreadLink.count({
        where: { agentChannelId: presenceId },
      }),
    ).toBe(1);
  });
});
