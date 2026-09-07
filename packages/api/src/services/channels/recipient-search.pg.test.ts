import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { proofDatabaseUrl } from "../../testing/pg-proof";

/**
 * The find_recipient proofs — discovery over the connected tenant, the
 * anchor write, and the anchor-first resolution that makes tagging
 * UNLINKED people safe (roadmap PR 3).
 *
 * The properties pinned here, each mutation-proof:
 *  - the union answer: linked teammates come back `verified` with OUR name,
 *    workspace-roster members come back unverified with their profile name;
 *  - the tenant fence: a foreign team_id or is_stranger member NEVER
 *    appears, whatever their name matches;
 *  - the anchor: a pick binds name → provider user id in the conversation,
 *    and resolveMentionNames answers from the anchor BEFORE the directory —
 *    including for names no directory has (the unlinked mention);
 *  - the RENAME pin: after the pick, changing the member's Slack profile
 *    changes nothing — the anchor's id already decided the ping;
 *  - tenancy: another conversation's anchors never answer.
 */

const PROOF_URL = proofDatabaseUrl();

const P = "recip-";
const ORG = `${P}org`;
const OTHER_ORG = `${P}other-org`;
const WORKSPACE = `${P}ws`;
const OWNER = `${P}owner`;
const DAN = `${P}dan`;
const TEAM = "T-RECIP";

let db: typeof import("@onecli/db").db;
let search: typeof import("./recipient-search-service");
let mentions: typeof import("./mention-resolution-service");

// ── Fake Slack (users.list / conversations.list) ───────────────────────────

let slackServer: Server;
/** The roster the fake serves — tests reshape it per arm. */
let rosterMembers: unknown[] = [];
let rosterChannels: unknown[] = [];

const startSlackFake = (): Promise<string> =>
  new Promise((resolve) => {
    slackServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      req.on("end", () => {
        const method = (req.url ?? "/").slice(1);
        res.writeHead(200, { "content-type": "application/json" });
        if (method === "users.list") {
          res.end(JSON.stringify({ ok: true, members: rosterMembers }));
        } else if (method === "conversations.list") {
          res.end(JSON.stringify({ ok: true, channels: rosterChannels }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    slackServer.listen(0, "127.0.0.1", () => {
      const { port } = slackServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

// ── Seeding (the mentions.pg pattern) ──────────────────────────────────────

const seedAgent = async (suffix: string) => {
  const agent = await db.agent.create({
    data: {
      identifier: `${P}agent-${suffix}`,
      name: `Recip Agent ${suffix}`,
      workspaceId: WORKSPACE,
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
      externalId: TEAM,
      name: "Recip Workspace",
      createdByUserId: OWNER,
    },
    select: { id: true },
  });

const seedPresence = async (agentId: string, integrationId: string) => {
  const { getCrypto } = await import("../../providers");
  const credentials = await getCrypto().encrypt(
    JSON.stringify({ botToken: "xoxb-recip-test" }),
  );
  return db.agentChannel.create({
    data: {
      agentId,
      integrationId,
      provider: "slack",
      externalId: `${P}bot`,
      identityRef: `${P}identity`,
      transport: "socket",
      status: "active",
      credentials,
    },
    select: { id: true },
  });
};

const seedConversation = async (agentId: string, suffix: string) => {
  const conversation = await db.conversation.create({
    data: { agentId, source: "slack", externalRef: `${P}${suffix}` },
    select: { id: true },
  });
  return conversation.id;
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
  search = await import("./recipient-search-service");
  mentions = await import("./mention-resolution-service");

  await reset();
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });

  await db.organization.createMany({
    data: [
      { id: ORG, name: ORG, slug: ORG },
      { id: OTHER_ORG, name: OTHER_ORG, slug: OTHER_ORG },
    ],
  });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Recip Workspace", organizationId: ORG },
  });
  await db.user.createMany({
    data: [
      { id: OWNER, email: `${OWNER}@example.com`, externalAuthId: OWNER },
      {
        id: DAN,
        email: `${DAN}@example.com`,
        externalAuthId: DAN,
        name: "Dan Abramov",
      },
    ],
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await reset();
  rosterMembers = [];
  rosterChannels = [];
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  slackServer?.close();
});

describe.skipIf(!PROOF_URL)("findPeople", () => {
  it("unions verified links with the unverified roster, tenant-fenced", async () => {
    const agentId = await seedAgent("union");
    const integration = await seedIntegration();
    await seedPresence(agentId, integration.id);
    await linkUser(integration.id, "U0DAN", DAN);
    rosterMembers = [
      // Linked (already verified) — must NOT duplicate as unverified.
      { id: "U0DAN", team_id: TEAM, profile: { display_name: "danny" } },
      // Unlinked same-tenant human — the Tomer case.
      { id: "U0TOMER", team_id: TEAM, profile: { display_name: "Dan Tomer" } },
      // Foreign tenant — Slack Connect, must never appear.
      {
        id: "U0EVIL",
        team_id: "T-FOREIGN",
        profile: { display_name: "Dan Evil" },
      },
      // Stranger flag — must never appear even with the right team.
      {
        id: "U0STRANGE",
        team_id: TEAM,
        is_stranger: true,
        profile: { display_name: "Dan Strange" },
      },
      // Bot — an APP candidate since 4e (labeled, not filtered).
      {
        id: "U0BOT",
        team_id: TEAM,
        is_bot: true,
        profile: { display_name: "Dan Bot" },
      },
    ];

    const people = await search.findPeople(agentId, "dan");
    const byRef = new Map(people.map((p) => [p.ref, p]));

    expect(byRef.get("U0DAN")).toMatchObject({
      name: "Dan Abramov", // OUR name, not the profile's "danny"
      verified: true,
    });
    expect(byRef.get("U0TOMER")).toMatchObject({
      name: "Dan Tomer",
      verified: false,
    });
    expect(byRef.has("U0EVIL")).toBe(false);
    expect(byRef.has("U0STRANGE")).toBe(false);
    // 4e: the bot IS discovered — labeled app, never silently hidden.
    expect(byRef.get("U0BOT")).toMatchObject({ kind: "app", name: "Dan Bot" });
  });

  it("answers empty without an active presence (off-channel agent)", async () => {
    const agentId = await seedAgent("nopresence");
    expect(await search.findPeople(agentId, "dan")).toEqual([]);
  });
});

describe.skipIf(!PROOF_URL)("findChannels", () => {
  it("returns visible channels with membership, read-only shape", async () => {
    const agentId = await seedAgent("chans");
    const integration = await seedIntegration();
    await seedPresence(agentId, integration.id);
    rosterChannels = [
      { id: "C0GEN", name: "general", is_member: true },
      {
        id: "C0SOC",
        name: "general-social",
        is_member: false,
        is_private: true,
      },
      { id: "C0GONE", name: "general-old", is_archived: true },
    ];

    const channels = await search.findChannels(agentId, "#general");
    const names = channels.map((c) => c.name);
    expect(names).toContain("#general");
    expect(names).toContain("#general-social");
    expect(names).not.toContain("#general-old");
    expect(channels.find((c) => c.ref === "C0GEN")).toMatchObject({
      member: true,
      private: false,
    });
  });

  it("separator folding: 'guy private' finds guy-private (the live miss)", async () => {
    const agentId = await seedAgent("sep");
    const integration = await seedIntegration();
    await seedPresence(agentId, integration.id);
    rosterChannels = [{ id: "C0GP", name: "guy-private", is_member: true }];

    const channels = await search.findChannels(agentId, "guy private");
    expect(channels.map((c) => c.ref)).toContain("C0GP");
    // And the returned name keeps the REAL spelling.
    expect(channels[0]!.name).toBe("#guy-private");
  });

  it("separator folding works for people too (dan.abramov)", async () => {
    const agentId = await seedAgent("sepp");
    const integration = await seedIntegration();
    await seedPresence(agentId, integration.id);
    rosterMembers = [
      { id: "U0DOT", team_id: TEAM, profile: { display_name: "dan.abramov" } },
    ];

    const people = await search.findPeople(agentId, "dan abramov");
    expect(people.map((p) => p.ref)).toContain("U0DOT");
  });
});

describe.skipIf(!PROOF_URL)("anchors — the id-bound pick", () => {
  it("an anchored UNLINKED name resolves; the id survives a profile rename", async () => {
    const agentId = await seedAgent("anchor");
    const integration = await seedIntegration();
    const presence = await seedPresence(agentId, integration.id);
    const conversationId = await seedConversation(agentId, "anchor");

    await search.anchorRecipient({
      conversationId,
      name: "Dan Tomer",
      externalUserId: "U0TOMER",
    });

    // Resolution BEFORE any directory entry exists: the anchor answers.
    const resolved = await mentions.resolveMentionNames(
      presence.id,
      ["dan tomer"],
      conversationId,
    );
    expect(resolved).toEqual([
      {
        kind: "resolved",
        name: "dan tomer",
        externalUserId: "U0TOMER",
        displayName: "Dan Tomer",
      },
    ]);

    // THE RENAME PIN: the roster changing (someone renames themselves
    // "Dan Tomer" or the real one renames away) is invisible here — the
    // anchor already bound the id. Nothing about resolution consults the
    // provider at render time, which IS the anti-impersonation property.
    rosterMembers = [
      {
        id: "U0IMPOSTOR",
        team_id: TEAM,
        profile: { display_name: "Dan Tomer" },
      },
    ];
    const after = await mentions.resolveMentionNames(
      presence.id,
      ["dan tomer"],
      conversationId,
    );
    expect(after[0]).toMatchObject({ externalUserId: "U0TOMER" });
  });

  it("an anchor outranks a directory name, and re-picking overwrites", async () => {
    const agentId = await seedAgent("outrank");
    const integration = await seedIntegration();
    const presence = await seedPresence(agentId, integration.id);
    const conversationId = await seedConversation(agentId, "outrank");
    await linkUser(integration.id, "U0DAN", DAN);

    // Directory alone: dan abramov → U0DAN.
    const before = await mentions.resolveMentionNames(
      presence.id,
      ["dan abramov"],
      conversationId,
    );
    expect(before[0]).toMatchObject({ externalUserId: "U0DAN" });

    // An explicit pick of the same name at a different id wins.
    await search.anchorRecipient({
      conversationId,
      name: "Dan Abramov",
      externalUserId: "U0OTHERDAN",
    });
    const anchored = await mentions.resolveMentionNames(
      presence.id,
      ["dan abramov"],
      conversationId,
    );
    expect(anchored[0]).toMatchObject({ externalUserId: "U0OTHERDAN" });

    // Last pick wins.
    await search.anchorRecipient({
      conversationId,
      name: "Dan Abramov",
      externalUserId: "U0DAN",
    });
    const repointed = await mentions.resolveMentionNames(
      presence.id,
      ["dan abramov"],
      conversationId,
    );
    expect(repointed[0]).toMatchObject({ externalUserId: "U0DAN" });
  });

  it("TENANCY: another conversation's anchors never answer, and no conversationId means directory-only", async () => {
    const agentId = await seedAgent("tenancy");
    const integration = await seedIntegration();
    const presence = await seedPresence(agentId, integration.id);
    const conversationA = await seedConversation(agentId, "tenancy-a");
    const conversationB = await seedConversation(agentId, "tenancy-b");

    await search.anchorRecipient({
      conversationId: conversationA,
      name: "Dan Tomer",
      externalUserId: "U0TOMER",
    });

    const foreign = await mentions.resolveMentionNames(
      presence.id,
      ["dan tomer"],
      conversationB,
    );
    expect(foreign[0]).toMatchObject({ kind: "unknown" });

    const withoutConversation = await mentions.resolveMentionNames(
      presence.id,
      ["dan tomer"],
    );
    expect(withoutConversation[0]).toMatchObject({ kind: "unknown" });
  });

  it("CROSS-AGENT: another agent's conversation never lends its anchors, even when named", async () => {
    // The host re-checks its own inputs (projection is never authority): a
    // resolve call naming agent B's conversation through agent A's presence
    // must resolve directory-only — the mismatched pair lends nothing.
    const agentA = await seedAgent("xagent-a");
    const integration = await seedIntegration();
    const presenceA = await seedPresence(agentA, integration.id);
    const agentB = await seedAgent("xagent-b");
    const conversationB = await seedConversation(agentB, "xagent-b");

    await search.anchorRecipient({
      conversationId: conversationB,
      name: "Dan Tomer",
      externalUserId: "U0TOMER",
    });

    const crossed = await mentions.resolveMentionNames(
      presenceA.id,
      ["dan tomer"],
      conversationB, // agent B's conversation named through agent A's presence
    );
    expect(crossed[0]).toMatchObject({ kind: "unknown" });
  });

  it("a CHANNEL anchor resolves @[#name] to the channel id", async () => {
    const agentId = await seedAgent("chanchor");
    const integration = await seedIntegration();
    const presence = await seedPresence(agentId, integration.id);
    const conversationId = await seedConversation(agentId, "chanchor");

    await search.anchorRecipient({
      conversationId,
      name: "#guy-private",
      externalUserId: "C0GP",
    });

    const resolved = await mentions.resolveMentionNames(
      presence.id,
      ["#guy-private"],
      conversationId,
    );
    expect(resolved[0]).toMatchObject({
      kind: "resolved",
      externalUserId: "C0GP",
    });
  });
});
