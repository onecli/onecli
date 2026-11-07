import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakeSlackServer } from "@onecli/channels/slack/testing";

import { proofDatabaseUrl } from "../../testing/pg-proof.js";

/**
 * The "Sync image" button on REAL PostgreSQL against the fake Slack origin
 * and a fake avatar CDN: it reads the agent's app PROFILE icon (auth.test ->
 * bots.info with the app's own bot token), shows it on the card, and copies
 * a real upload onto the agent's image.
 *
 * Pinned: Slack's stock mark is never copied; a changed icon is copied once;
 * pressing again without a change keeps an image replaced in OneCLI since;
 * a double click reads Slack once; a refusal surfaces as an error and frees
 * an immediate retry; the press is fenced to the caller's workspace and to
 * live apps (404); and NONE of it moves `updatedAt` (a config-feed etag
 * input).
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
let db: Db;
let getCrypto: typeof import("../../providers").getCrypto;
let syncPresenceIcon: typeof import("./presence-icons-service").syncPresenceIcon;
let slack: FakeSlackServer;
let cdn: Server;
let cdnUrl: string;
let cdnHits: string[] = [];

const P = "iconsync-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const OWNER = `${P}owner`;

/** A minimal valid PNG (magic bytes are what the image service checks). */
const png = (tag: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([tag]),
  ]);

/** What the fake Slack answers for bots.info, per test. A stock mark is
 * served off Slack's static host, never the avatar CDN. */
const STOCK = "https://a.slack-edge.com/80588/img/plugins/app/service_72.png";
let botIcon: string;
const upload = (n: number) => `${cdnUrl}/2026-10-18/${n}_72.png`;

let seq = 0;
/** One Slack integration per org (a unique constraint); apps share it. */
const integrationId = async (): Promise<string> =>
  (
    (await db.channelIntegration.findFirst({
      where: { organizationId: ORG, provider: "slack" },
      select: { id: true },
    })) ??
    (await db.channelIntegration.create({
      data: {
        organizationId: ORG,
        provider: "slack",
        externalId: `T-${P}team`,
        name: ORG,
        createdByUserId: OWNER,
      },
      select: { id: true },
    }))
  ).id;

const seedApp = async (status = "active") => {
  seq += 1;
  const agent = await db.agent.create({
    data: {
      workspaceId: WORKSPACE,
      name: `iconsync ${seq}`,
      identifier: `${P}${seq}`,
      accessToken: `aoc_${P}${seq}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  const row = await db.agentChannel.create({
    data: {
      agentId: agent.id,
      integrationId: await integrationId(),
      provider: "slack",
      externalId: `A0ICON${seq}`,
      identityRef: `U0BOT${seq}`,
      transport: "socket",
      appMode: "agent",
      status,
      createdByUserId: OWNER,
      credentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: `xoxb-${P}${seq}` }),
      ),
    },
    select: { id: true, updatedAt: true },
  });
  return { id: row.id, agentId: agent.id, updatedAt: row.updatedAt };
};

const presence = (id: string) =>
  db.agentChannel.findUniqueOrThrow({
    where: { id },
    select: {
      iconUrl: true,
      iconSyncedUrl: true,
      iconCheckedAt: true,
      updatedAt: true,
    },
  });

const agentImage = async (agentId: string) =>
  Buffer.from(
    (
      await db.agent.findUniqueOrThrow({
        where: { id: agentId },
        select: { imageData: true },
      })
    ).imageData ?? new Uint8Array(),
  );

/** A press, as the route makes it: the caller's workspace. */
const press = (agentId: string, workspaceId = WORKSPACE) =>
  syncPresenceIcon({ workspaceId, agentId, provider: "slack" });

/** Step past the 3s double-click guard without sleeping. */
const pastGuard = (id: string) =>
  db.$executeRaw`UPDATE agent_channels SET icon_checked_at = NULL WHERE id = ${id}`;

const answerBotIcon = () => ({
  ok: true,
  bot: { icons: { image_48: botIcon, image_72: botIcon } },
});

beforeAll(async () => {
  if (!PROOF_URL) return;
  const { startFakeSlackServer } =
    await import("@onecli/channels/slack/testing");
  slack = await startFakeSlackServer();
  // The avatar CDN: an upload number's tagged PNG, else non-image bytes.
  cdn = createServer((req, res) => {
    cdnHits.push(req.url ?? "");
    const n = /\/(\d+)_72\.png$/.exec(req.url ?? "")?.[1];
    res.writeHead(200, { "content-type": "image/png" });
    res.end(n ? png(Number(n)) : "<svg/>");
  });
  await new Promise<void>((resolve) =>
    cdn.listen(0, "127.0.0.1", () => resolve()),
  );
  cdnUrl = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}`;

  process.env.DATABASE_URL = PROOF_URL;
  process.env.SLACK_API_BASE_URL = slack.url;
  process.env.SLACK_CDN_BASE_URL = cdnUrl;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  ({ db } = await import("@onecli/db"));
  ({ getCrypto } = await import("../../providers"));
  ({ syncPresenceIcon } = await import("./presence-icons-service"));

  slack.respond("auth.test", () => ({
    ok: true,
    team_id: "T0",
    user_id: "U0BOT",
    bot_id: "B0BOT",
  }));

  await dropAll();
  await db.user.create({
    data: { id: OWNER, email: `${OWNER}@example.com`, externalAuthId: OWNER },
  });
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: WORKSPACE, organizationId: ORG },
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  slack.calls.length = 0;
  slack.respond("bots.info", answerBotIcon);
  cdnHits = [];
  botIcon = STOCK;
});

const dropAll = async () => {
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: OWNER } });
};

afterAll(async () => {
  if (!PROOF_URL) return;
  await dropAll();
  await slack.close();
  await new Promise<void>((resolve) => cdn.close(() => resolve()));
});

describe.skipIf(!PROOF_URL)("Sync image (presence icon sync)", () => {
  it("never copies Slack's stock mark, and leaves the card on the logo", async () => {
    const app = await seedApp();
    expect(await press(app.agentId)).toEqual({ changed: false });
    const row = await presence(app.id);
    expect(row.iconUrl).toBeNull();
    expect(row.iconSyncedUrl).toBeNull();
    expect(cdnHits).toHaveLength(0);
    // Both reads used the app's OWN bot token, keyed by auth.test's bot id.
    expect(slack.callsTo("auth.test")[0]?.token).toBe(`xoxb-${P}${seq}`);
    expect(slack.callsTo("bots.info")[0]).toMatchObject({
      token: `xoxb-${P}${seq}`,
      form: { bot: "B0BOT" },
    });
  });

  it("copies a real upload onto the agent image", async () => {
    const app = await seedApp();
    botIcon = upload(1);
    expect(await press(app.agentId)).toEqual({ changed: true });
    const row = await presence(app.id);
    expect(row.iconUrl).toBe(upload(1));
    expect(row.iconSyncedUrl).toBe(upload(1));
    expect(await agentImage(app.agentId)).toEqual(png(1));
  });

  it("pressing again with no Slack change keeps an image replaced in OneCLI", async () => {
    const app = await seedApp();
    botIcon = upload(1);
    await press(app.agentId);
    await db.agent.update({
      where: { id: app.agentId },
      data: { imageData: new Uint8Array(png(7)), imageKey: "f".repeat(32) },
    });
    await pastGuard(app.id);
    expect(await press(app.agentId)).toEqual({ changed: false });
    expect(await agentImage(app.agentId)).toEqual(png(7));

    // Then the Slack icon changes and the user presses: it follows.
    botIcon = upload(2);
    await pastGuard(app.id);
    expect(await press(app.agentId)).toEqual({ changed: true });
    expect(await agentImage(app.agentId)).toEqual(png(2));
  });

  it("a double click reads Slack once", async () => {
    const app = await seedApp();
    botIcon = upload(1);
    const results = await Promise.all([press(app.agentId), press(app.agentId)]);
    expect(results.map((r) => r.changed).sort()).toEqual([false, true]);
    expect(slack.callsTo("bots.info")).toHaveLength(1);
    expect(cdnHits).toHaveLength(1);
  });

  it("a Slack refusal surfaces as an error and frees an immediate retry", async () => {
    const app = await seedApp();
    slack.respond("bots.info", () => ({ ok: false, error: "invalid_auth" }));
    await expect(press(app.agentId)).rejects.toThrow(/Couldn't read/);
    const row = await presence(app.id);
    expect(row.iconSyncedUrl).toBeNull();
    expect(row.iconCheckedAt).toBeNull();

    // Slack recovers; the retry reads again right away.
    slack.respond("bots.info", answerBotIcon);
    botIcon = upload(3);
    expect(await press(app.agentId)).toEqual({ changed: true });
  });

  it("keeps the image service's refusal, and never marks it synced", async () => {
    const app = await seedApp();
    // A real upload whose bytes are not an image the agent can carry.
    botIcon = `${cdnUrl}/2026-10-18/not-an-image.svg`;
    await expect(press(app.agentId)).rejects.toThrow(/PNG, JPEG, WebP, or GIF/);
    const row = await presence(app.id);
    expect(row.iconUrl).toBe(botIcon);
    expect(row.iconSyncedUrl).toBeNull();
  });

  it("is fenced to the caller's workspace (404, no Slack call)", async () => {
    const app = await seedApp();
    botIcon = upload(1);
    await expect(press(app.agentId, "other-workspace")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(slack.calls).toHaveLength(0);
    expect((await presence(app.id)).iconSyncedUrl).toBeNull();
  });

  it("never syncs a detached app (404, no Slack call)", async () => {
    const app = await seedApp("disabled");
    botIcon = upload(1);
    await expect(press(app.agentId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(slack.calls).toHaveLength(0);
  });

  it("never moves updatedAt (the config-feed etag input)", async () => {
    const app = await seedApp();
    botIcon = upload(1);
    await press(app.agentId);
    expect((await presence(app.id)).updatedAt).toEqual(app.updatedAt);
  });
});
