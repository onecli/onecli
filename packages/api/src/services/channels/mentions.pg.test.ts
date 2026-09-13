import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../../testing/pg-proof.js";

/**
 * Outbound mention resolution on REAL PostgreSQL — the control-plane half of
 * the `@[Name]` contract:
 *
 * - the directory is LINKED TEAMMATES ONLY, per integration (the tenancy
 *   fence: another org's links never answer);
 * - matching is EXACT on the normalized form; two links with one name answer
 *   `ambiguous` with both display names, never a pick;
 * - failures recorded on a turn surface as ONE durable `notice` event
 *   (idempotent per turn) whose structured payload the next turn's context
 *   note reads back;
 * - the context note teaches the syntax, lists mentionable names, and
 *   reports the previous turn's failures — and stays null off-channel.
 *
 * Same harness shape as the sibling pg suites: the shared proof database,
 * prefix-fenced; no Slack fake needed (resolution is pure DB).
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Mentions = typeof import("./mention-resolution-service");
type TurnContext = typeof import("../turn-context-service");

let db: Db;
let mentions: Mentions;
let turnContext: TurnContext;

const P = "mntpg-";
const ORG = `${P}org`;
const OTHER_ORG = `${P}other-org`;
const WORKSPACE = `${P}proj`;
const OWNER = `${P}owner`;
const DAN = `${P}dan`;
const DANA = `${P}dana`;
const TWIN = `${P}twin`;

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
  return agent.id;
};

const seedIntegration = async (organizationId = ORG) =>
  db.channelIntegration.create({
    data: {
      organizationId,
      provider: "slack",
      externalId: `T-${organizationId}`,
      name: "Mention Co",
      credentials: null,
      createdByUserId: OWNER,
    },
    select: { id: true },
  });

const seedPresence = async (agentId: string, integrationId: string) =>
  db.agentChannel.create({
    data: {
      agentId,
      integrationId,
      provider: "slack",
      externalId: `A-${agentId.slice(0, 8)}`,
      identityRef: "UBOT",
      transport: "socket",
      status: "active",
      credentials: null,
      createdByUserId: OWNER,
    },
    select: { id: true },
  });

const linkUser = (
  integrationId: string,
  externalUserId: string,
  userId: string,
) =>
  db.channelUserLink.create({
    data: { integrationId, externalUserId, userId, linkedVia: "manual" },
    select: { id: true },
  });

/** A channel-linked conversation with one finished turn — the shape the
 * failure record and the context note both hang off. */
const seedLinkedTurn = async (suffix: string) => {
  const agentId = await seedAgent(suffix);
  const integration = await seedIntegration();
  const presence = await seedPresence(agentId, integration.id);
  const conversation = await db.conversation.create({
    data: { agentId, source: "slack", externalRef: `${P}${suffix}` },
    select: { id: true },
  });
  await db.channelThreadLink.create({
    data: {
      agentChannelId: presence.id,
      conversationId: conversation.id,
      externalThreadId: `C-${suffix}:1`,
      kind: "group",
    },
  });
  const turn = await db.turn.create({
    data: {
      conversationId: conversation.id,
      message: "ping dan",
      status: "done",
      source: "slack",
      userId: null,
      finishedAt: new Date(),
    },
    select: { id: true, createdAt: true },
  });
  return {
    agentId,
    integrationId: integration.id,
    presenceId: presence.id,
    conversationId: conversation.id,
    turnId: turn.id,
    turnCreatedAt: turn.createdAt,
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
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  ({ db } = await import("@onecli/db"));
  mentions = await import("./mention-resolution-service");
  turnContext = await import("../turn-context-service");

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
    data: { id: WORKSPACE, name: "Mentions Workspace", organizationId: ORG },
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
      {
        id: DANA,
        email: `${DANA}@example.com`,
        externalAuthId: DANA,
        name: "Dana Kim",
      },
      {
        id: TWIN,
        email: `${TWIN}@example.com`,
        externalAuthId: TWIN,
        // The SAME normalized name as DAN — the ambiguity arm's prey.
        name: "dan  ABRAMOV",
      },
    ],
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await reset();
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
});

describe.skipIf(!PROOF_URL)("resolveMentionNames", () => {
  it("resolves an exact normalized name to the linked identity", async () => {
    const { integrationId, presenceId } = await seedLinkedTurn("resolve");
    await linkUser(integrationId, "U0DAN", DAN);

    const out = await mentions.resolveMentionNames(presenceId, ["dan abramov"]);
    expect(out).toEqual([
      {
        kind: "resolved",
        name: "dan abramov",
        externalUserId: "U0DAN",
        displayName: "Dan Abramov",
      },
    ]);
  });

  it("answers unknown for a name with no link — exact match only, never fuzzy", async () => {
    const { integrationId, presenceId } = await seedLinkedTurn("unknown");
    await linkUser(integrationId, "U0DAN", DAN);

    const out = await mentions.resolveMentionNames(presenceId, [
      "dan", // a real first name — still NOT a match (the decision record)
      "nobody",
    ]);
    expect(out).toEqual([
      { kind: "unknown", name: "dan" },
      { kind: "unknown", name: "nobody" },
    ]);
  });

  it("answers ambiguous with both display names when two links share a name", async () => {
    const { integrationId, presenceId } = await seedLinkedTurn("ambiguous");
    await linkUser(integrationId, "U0DAN", DAN);
    await linkUser(integrationId, "U0TWIN", TWIN);

    const out = await mentions.resolveMentionNames(presenceId, ["dan abramov"]);
    expect(out).toEqual([
      {
        kind: "ambiguous",
        name: "dan abramov",
        // The twin's stored name has a doubled space — the directory
        // CLEANS display names (collapse/clamp) before they travel.
        candidates: ["Dan Abramov", "dan ABRAMOV"],
      },
    ]);
  });

  it("TENANCY: another integration's links never answer", async () => {
    const { presenceId } = await seedLinkedTurn("tenancy");
    const foreign = await seedIntegration(OTHER_ORG);
    await linkUser(foreign.id, "U0DAN", DAN);

    const out = await mentions.resolveMentionNames(presenceId, ["dan abramov"]);
    expect(out).toEqual([{ kind: "unknown", name: "dan abramov" }]);
  });

  it("refuses an unknown presence", async () => {
    await expect(
      mentions.resolveMentionNames("no-such-presence", ["dan abramov"]),
    ).rejects.toThrow("Presence not found");
  });
});

describe.skipIf(!PROOF_URL)("recordMentionFailures + the context note", () => {
  it("records ONE durable notice per turn (idempotent) and the next turn's context reads it back", async () => {
    const seeded = await seedLinkedTurn("record");
    await linkUser(seeded.integrationId, "U0DAN", DAN);

    const failures = [
      { kind: "unknown" as const, name: "Nobody" },
      {
        kind: "ambiguous" as const,
        name: "Dan",
        candidates: ["Dan Abramov", "Dana Kim"],
      },
    ];
    await mentions.recordMentionFailures(seeded.turnId, failures);
    // The adapter's retry / a twin racing the report: still one notice.
    await mentions.recordMentionFailures(seeded.turnId, failures);

    const notices = await db.turnEvent.findMany({
      where: { turnId: seeded.turnId, type: "notice" },
    });
    expect(notices).toHaveLength(1);
    const payload = notices[0]!.payload as {
      text: string;
      mentionFailures: unknown;
    };
    // The human-readable half (the web transcript renders this).
    expect(payload.text).toContain("@[Nobody] didn't match");
    expect(payload.text).toContain("Dan Abramov, Dana Kim");
    // The structured half (the context note reads this).
    expect(payload.mentionFailures).toEqual(failures);

    // The NEXT turn's context: syntax + directory + last turn's failures.
    const next = await db.turn.create({
      data: {
        conversationId: seeded.conversationId,
        message: "follow-up",
        status: "pending",
        source: "slack",
        userId: null,
      },
      select: { createdAt: true },
    });
    const note = await mentions.buildMentionContext(
      seeded.conversationId,
      next.createdAt,
    );
    expect(note).toContain("@[Their Name]");
    expect(note).toContain("Mentionable: Dan Abramov.");
    expect(note).toContain("@[Nobody] didn't match anyone");
    expect(note).toContain("@[Dan] was ambiguous (Dan Abramov, Dana Kim)");
  });

  it("refuses a turn outside any linked conversation (the adapter fence)", async () => {
    const agentId = await seedAgent("unlinked");
    const conversation = await db.conversation.create({
      data: { agentId, source: "web", externalRef: null },
      select: { id: true },
    });
    const turn = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "hi",
        status: "done",
        source: "web",
        userId: OWNER,
      },
      select: { id: true },
    });
    await expect(
      mentions.recordMentionFailures(turn.id, [{ kind: "unknown", name: "x" }]),
    ).rejects.toThrow("Turn not found");
  });

  it("buildMentionContext is null off-channel and buildTurnContext rides it on-channel", async () => {
    const agentId = await seedAgent("web-conv");
    const webConversation = await db.conversation.create({
      data: { agentId, source: "web", externalRef: null },
      select: { id: true },
    });
    expect(
      await mentions.buildMentionContext(webConversation.id, new Date()),
    ).toBeNull();

    // On-channel: the full dispatch-time context carries the mention note
    // even with no memory saved (the integration seam the runner uses).
    const seeded = await seedLinkedTurn("dispatch");
    await linkUser(seeded.integrationId, "U0DAN", DAN);
    const context = await turnContext.buildTurnContext(
      seeded.agentId,
      seeded.conversationId,
      seeded.turnId,
      "ping dan",
    );
    expect(context).toContain("@[Their Name]");
    expect(context).toContain("Mentionable: Dan Abramov.");
  });

  it("a near-miss rides the notice and the note with the write-it-right fix", async () => {
    const seeded = await seedLinkedTurn("nearmiss");
    await linkUser(seeded.integrationId, "U0DAN", DAN);
    await mentions.recordMentionFailures(seeded.turnId, [
      { kind: "near_miss", name: "Dan Abramov" },
    ]);
    const notice = await db.turnEvent.findFirstOrThrow({
      where: { turnId: seeded.turnId, type: "notice" },
    });
    expect((notice.payload as { text: string }).text).toContain(
      "plain @Dan Abramov posted as ordinary text and pinged NOBODY",
    );
    const next = await db.turn.create({
      data: {
        conversationId: seeded.conversationId,
        message: "follow-up",
        status: "pending",
        source: "slack",
        userId: null,
      },
      select: { createdAt: true },
    });
    const note = await mentions.buildMentionContext(
      seeded.conversationId,
      next.createdAt,
    );
    expect(note).toContain(
      "plain @Dan Abramov pinged NOBODY - write @[Dan Abramov]",
    );
  });

  it("names nobody when the integration has no links yet", async () => {
    const seeded = await seedLinkedTurn("empty");
    const note = await mentions.buildMentionContext(
      seeded.conversationId,
      seeded.turnCreatedAt,
    );
    expect(note).toContain("Mentionable: nobody is listed yet");
  });

  it("a linked teammate's DIRECT thread names its owner — the DM identity line", async () => {
    // The live incident (dev, 2026-09-04): a linked teammate's DM carries
    // no speaker prefix (identity IS the conversation), so nothing told
    // the model who it was talking to and it reached for a stale memory
    // name. The direct thread's note must name the authenticated owner.
    const seeded = await seedLinkedTurn("dmowner");
    await linkUser(seeded.integrationId, "U0DAN", DAN);
    await db.channelThreadLink.update({
      where: { conversationId: seeded.conversationId },
      data: { kind: "direct", externalUserId: "U0DAN" },
    });

    const note = await mentions.buildMentionContext(
      seeded.conversationId,
      seeded.turnCreatedAt,
    );
    expect(note).toContain("This is a direct conversation with Dan Abramov");
  });

  it("a GROUP thread carries no identity line", async () => {
    // Group: many voices, the `name:` prefix attributes each message.
    const group = await seedLinkedTurn("dmgroup");
    await linkUser(group.integrationId, "U0DAN", DAN);
    const groupNote = await mentions.buildMentionContext(
      group.conversationId,
      group.turnCreatedAt,
    );
    expect(groupNote).not.toContain("This is a direct conversation");
  });

  it("a GUEST direct thread carries no identity line", async () => {
    // Guest DM: externalUserId is null by construction (the person lane),
    // identity rides the `name (guest):` prefix. Naming the wrong owner
    // would be worse than naming none.
    const guest = await seedLinkedTurn("dmguest");
    await linkUser(guest.integrationId, "U0DAN", DAN);
    await db.channelThreadLink.update({
      where: { conversationId: guest.conversationId },
      data: { kind: "direct", externalUserId: null },
    });
    const guestNote = await mentions.buildMentionContext(
      guest.conversationId,
      guest.turnCreatedAt,
    );
    expect(guestNote).not.toContain("This is a direct conversation");
  });

  it("a direct thread whose owner was UNLINKED degrades to no identity line", async () => {
    // The link is revocable governance data: an admin unlinking the user
    // must not crash the note or leave a stale name — the line simply
    // disappears with the link.
    const seeded = await seedLinkedTurn("dmunlinked");
    await linkUser(seeded.integrationId, "U0DAN", DAN);
    await db.channelThreadLink.update({
      where: { conversationId: seeded.conversationId },
      data: { kind: "direct", externalUserId: "U0GONE" },
    });
    const note = await mentions.buildMentionContext(
      seeded.conversationId,
      seeded.turnCreatedAt,
    );
    expect(note).not.toContain("This is a direct conversation");
    // The rest of the note still works — the miss never gates the turn.
    expect(note).toContain("Mentionable: Dan Abramov");
  });
});
