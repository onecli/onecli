import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakeSlackServer } from "@onecli/channels/slack/testing";

import { proofDatabaseUrl } from "../../testing/pg-proof.js";

/**
 * The once-per-app event sync (existing apps gain new events) on REAL
 * PostgreSQL against the shared fake Slack origin: an existing agent app,
 * created before `agent_session_stopped` joined the manifest, is brought up
 * to the current event list through the org's own credential, once, and
 * then left alone.
 *
 * Pinned: who is eligible (live agent-flavor apps only), the export-then-
 * add-only edit, one app per connection per pass, the claim parking a
 * refused app for the retry window, the success record taking the app out
 * for good, and that NONE of it moves `updatedAt` (a config-feed etag
 * input: a sync must never make every adapter re-download its config).
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
let db: Db;
let getCrypto: typeof import("../../providers").getCrypto;
let syncPresenceEvents: typeof import("./presence-events-service").syncPresenceEvents;
let BOT_EVENTS: readonly string[];
let slack: FakeSlackServer;

const P = "evsync-";
const ORG = `${P}org`;
const BARE_ORG = `${P}org-bare`;
const WORKSPACE = `${P}proj`;
const BARE_WORKSPACE = `${P}proj-bare`;
const OWNER = `${P}owner`;

/** An app exported from Slack before the Stop event existed. */
const OLD_EVENTS = [
  "message.im",
  "app_mention",
  "message.channels",
  "message.groups",
  "member_joined_channel",
  "member_left_channel",
  "app_uninstalled",
  "tokens_revoked",
];

const exportedManifest = (appId: string, botEvents: string[]) => ({
  display_information: { name: `app ${appId}` },
  features: { agent_view: { agent_description: "x" } },
  oauth_config: { scopes: { bot: ["chat:write", "assistant:write"] } },
  settings: {
    socket_mode_enabled: true,
    event_subscriptions: { bot_events: botEvents },
    interactivity: { is_enabled: true },
  },
});

/** Per-app manifests as the fake Slack holds them. */
let remote: Map<string, ReturnType<typeof exportedManifest>>;

const seedOrg = async (orgId: string, workspaceId: string) => {
  await db.organization.create({
    data: { id: orgId, name: orgId, slug: orgId },
  });
  await db.workspace.create({
    data: { id: workspaceId, name: workspaceId, organizationId: orgId },
  });
};

const seedIntegration = async (
  orgId: string,
  withCredential: boolean,
  accessToken = "xoxe.access-evsync",
) =>
  (
    await db.channelIntegration.create({
      data: {
        organizationId: orgId,
        provider: "slack",
        externalId: `T-${orgId}`,
        name: orgId,
        credentials: withCredential
          ? await getCrypto().encrypt(
              JSON.stringify({
                accessToken,
                refreshToken: "xoxe-refresh-evsync",
                // Far from expiry: no rotation, the stored token is used.
                expiresAt: Math.floor(Date.now() / 1000) + 6 * 3600,
              }),
            )
          : null,
        credentialsRotatedAt: withCredential ? new Date() : null,
        createdByUserId: OWNER,
      },
      select: { id: true },
    })
  ).id;

let seq = 0;
const seedApp = async (
  workspaceId: string,
  integrationId: string,
  options: { appMode?: string; status?: string; events?: string[] } = {},
) => {
  seq += 1;
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `evsync ${seq}`,
      identifier: `${P}${seq}`,
      accessToken: `aoc_${P}${seq}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  const externalId = `A0EVSYNC${seq}`;
  remote.set(
    externalId,
    exportedManifest(externalId, options.events ?? OLD_EVENTS),
  );
  const row = await db.agentChannel.create({
    data: {
      agentId: agent.id,
      integrationId,
      provider: "slack",
      externalId,
      transport: "socket",
      appMode: options.appMode ?? "agent",
      status: options.status ?? "active",
      createdByUserId: OWNER,
    },
    select: { id: true, updatedAt: true },
  });
  return { id: row.id, externalId, updatedAt: row.updatedAt };
};

const syncRow = (id: string) =>
  db.agentChannel.findUniqueOrThrow({
    where: { id },
    select: {
      syncedEvents: true,
      eventsSyncAttemptedAt: true,
      updatedAt: true,
    },
  });

const updatesTo = (appId: string) =>
  slack.callsTo("apps.manifest.update").filter((c) => c.form.app_id === appId);

beforeAll(async () => {
  if (!PROOF_URL) return;
  const { startFakeSlackServer } =
    await import("@onecli/channels/slack/testing");
  slack = await startFakeSlackServer();
  process.env.DATABASE_URL = PROOF_URL;
  process.env.SLACK_API_BASE_URL = slack.url;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  ({ db } = await import("@onecli/db"));
  ({ getCrypto } = await import("../../providers"));
  ({ syncPresenceEvents } = await import("./presence-events-service"));
  ({ BOT_EVENTS } = await import("./providers/slack/manifest"));

  // The fake holds each app's manifest: export reads it, update writes it.
  slack.respond("apps.manifest.export", (form) => {
    const manifest = remote.get(form.app_id ?? "");
    return manifest
      ? { ok: true, manifest }
      : { ok: false, error: "app_not_found" };
  });
  slack.respond("apps.manifest.update", (form) => {
    remote.set(form.app_id ?? "", JSON.parse(form.manifest ?? "{}"));
    return { ok: true, app_id: form.app_id, permissions_updated: false };
  });

  await dropAll();
  await db.user.create({
    data: { id: OWNER, email: `${OWNER}@example.com`, externalAuthId: OWNER },
  });
  await seedOrg(ORG, WORKSPACE);
  await seedOrg(BARE_ORG, BARE_WORKSPACE);
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({
    where: { organizationId: { in: [ORG, BARE_ORG] } },
  });
  remote = new Map();
  slack.calls.length = 0;
});

const dropAll = async () => {
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({
    where: { organizationId: { in: [ORG, BARE_ORG] } },
  });
  await db.workspace.deleteMany({
    where: { id: { in: [WORKSPACE, BARE_WORKSPACE] } },
  });
  await db.organization.deleteMany({ where: { id: { in: [ORG, BARE_ORG] } } });
  await db.user.deleteMany({ where: { id: OWNER } });
};

afterAll(async () => {
  if (!PROOF_URL) return;
  await dropAll();
  await slack.close();
});

describe.skipIf(!PROOF_URL)(
  "syncPresenceEvents (existing apps gain new events)",
  () => {
    it("adds the missing event to an existing agent app with the org's credential, once, without touching updatedAt", async () => {
      const integrationId = await seedIntegration(ORG, true);
      const app = await seedApp(WORKSPACE, integrationId, {
        events: [...OLD_EVENTS, "reaction_added"],
      });

      expect(await syncPresenceEvents()).toEqual({ synced: 1, deferred: 0 });

      const update = updatesTo(app.externalId);
      expect(update).toHaveLength(1);
      expect(update[0]!.token).toBe("xoxe.access-evsync");
      const written = remote.get(app.externalId)!;
      // Added, nothing dropped (the hand-added event stays), nothing else
      // in the exported manifest rewritten.
      expect(written.settings.event_subscriptions.bot_events).toEqual([
        ...OLD_EVENTS,
        "reaction_added",
        "channel_left",
        "group_left",
        "agent_session_stopped",
      ]);
      expect(written.oauth_config).toEqual(
        exportedManifest(app.externalId, []).oauth_config,
      );
      expect(written.features).toEqual(
        exportedManifest(app.externalId, []).features,
      );

      const row = await syncRow(app.id);
      expect(row.syncedEvents).toBe(BOT_EVENTS.join(","));
      expect(row.eventsSyncAttemptedAt).not.toBeNull();
      // Raw SQL only: the config feed's etag does not move.
      expect(row.updatedAt).toEqual(app.updatedAt);

      // Once: the next pass leaves it alone (no export, no update).
      expect(await syncPresenceEvents()).toEqual({ synced: 0, deferred: 0 });
      expect(slack.callsTo("apps.manifest.export")).toHaveLength(1);

      // And for good, not merely parked: past the retry window, the recorded
      // list is what keeps it out.
      await db.$executeRaw`
      UPDATE agent_channels
      SET events_sync_attempted_at = now() - interval '7 hours'
      WHERE id = ${app.id}`;
      expect(await syncPresenceEvents()).toEqual({ synced: 0, deferred: 0 });
      expect(slack.callsTo("apps.manifest.export")).toHaveLength(1);
    });

    it("records an app that already carries every event without writing its manifest", async () => {
      const integrationId = await seedIntegration(ORG, true);
      const app = await seedApp(WORKSPACE, integrationId, {
        events: [...BOT_EVENTS],
      });
      expect(await syncPresenceEvents()).toEqual({ synced: 1, deferred: 0 });
      expect(slack.callsTo("apps.manifest.export")).toHaveLength(1);
      expect(updatesTo(app.externalId)).toHaveLength(0);
      expect((await syncRow(app.id)).syncedEvents).toBe(BOT_EVENTS.join(","));
    });

    it("only live agent-flavor apps are eligible: regular, pending and disabled apps are never touched", async () => {
      const integrationId = await seedIntegration(ORG, true);
      const regular = await seedApp(WORKSPACE, integrationId, {
        appMode: "regular",
      });
      const pending = await seedApp(WORKSPACE, integrationId, {
        status: "pending_setup",
      });
      const disabled = await seedApp(WORKSPACE, integrationId, {
        status: "disabled",
      });

      expect(await syncPresenceEvents()).toEqual({ synced: 0, deferred: 0 });
      expect(slack.callsTo("apps.manifest.export")).toHaveLength(0);
      for (const app of [regular, pending, disabled]) {
        expect(await syncRow(app.id)).toMatchObject({
          syncedEvents: null,
          eventsSyncAttemptedAt: null,
        });
      }
    });

    it("serves one app per connection per pass (the org's credential is rate-limited per minute), converging over passes", async () => {
      const integrationId = await seedIntegration(ORG, true);
      const first = await seedApp(WORKSPACE, integrationId);
      const second = await seedApp(WORKSPACE, integrationId);

      expect(await syncPresenceEvents()).toEqual({ synced: 1, deferred: 0 });
      expect(await syncPresenceEvents()).toEqual({ synced: 1, deferred: 0 });
      expect(await syncPresenceEvents()).toEqual({ synced: 0, deferred: 0 });
      expect(updatesTo(first.externalId)).toHaveLength(1);
      expect(updatesTo(second.externalId)).toHaveLength(1);
    });

    it("an org with no credential defers, and the claim parks the app until the retry window passes", async () => {
      const integrationId = await seedIntegration(BARE_ORG, false);
      const app = await seedApp(BARE_WORKSPACE, integrationId);

      expect(await syncPresenceEvents()).toEqual({ synced: 0, deferred: 1 });
      expect(slack.callsTo("apps.manifest.export")).toHaveLength(0);
      const parked = await syncRow(app.id);
      expect(parked.syncedEvents).toBeNull();
      expect(parked.eventsSyncAttemptedAt).not.toBeNull();
      expect(parked.updatedAt).toEqual(app.updatedAt);

      // Parked: the next pass does not retry it.
      expect(await syncPresenceEvents()).toEqual({ synced: 0, deferred: 0 });

      // The org connects a credential (caught live on a real deployment: an
      // org parked for lacking one waited out the whole window after
      // connecting it). The change itself makes the app due: no wait.
      await db.channelIntegration.update({
        where: { id: integrationId },
        data: {
          credentials: await getCrypto().encrypt(
            JSON.stringify({
              accessToken: "xoxe.access-evsync",
              refreshToken: "xoxe-refresh-evsync",
              expiresAt: Math.floor(Date.now() / 1000) + 6 * 3600,
            }),
          ),
          credentialsRotatedAt: new Date(Date.now() + 1_000),
        },
      });
      expect(await syncPresenceEvents()).toEqual({ synced: 1, deferred: 0 });
      expect(updatesTo(app.externalId)).toHaveLength(1);
    });

    it("a parked app whose org's credential did NOT change waits out the window (no retry loop)", async () => {
      const integrationId = await seedIntegration(ORG, true);
      const app = await seedApp(WORKSPACE, integrationId);
      slack.respond("apps.manifest.export", () => ({
        ok: false,
        error: "app_not_found",
      }));
      try {
        expect(await syncPresenceEvents()).toEqual({ synced: 0, deferred: 1 });
        // The credential predates the attempt: three more passes, no retry.
        for (let i = 0; i < 3; i += 1) {
          expect(await syncPresenceEvents()).toEqual({
            synced: 0,
            deferred: 0,
          });
        }
        expect(slack.callsTo("apps.manifest.export")).toHaveLength(1);
      } finally {
        slack.respond("apps.manifest.export", (form) => {
          const manifest = remote.get(form.app_id ?? "");
          return manifest
            ? { ok: true, manifest }
            : { ok: false, error: "app_not_found" };
        });
      }
      expect((await syncRow(app.id)).syncedEvents).toBeNull();
    });

    it("a provider refusal defers without recording success; an app synced to an OLDER list is synced again", async () => {
      const integrationId = await seedIntegration(ORG, true);
      const app = await seedApp(WORKSPACE, integrationId);
      slack.respond("apps.manifest.update", () => ({
        ok: false,
        error: "invalid_manifest",
      }));
      try {
        expect(await syncPresenceEvents()).toEqual({ synced: 0, deferred: 1 });
        expect((await syncRow(app.id)).syncedEvents).toBeNull();
      } finally {
        slack.respond("apps.manifest.update", (form) => {
          remote.set(form.app_id ?? "", JSON.parse(form.manifest ?? "{}"));
          return { ok: true, app_id: form.app_id };
        });
      }

      // An app recorded against an older list (a later deploy added an event)
      // is eligible again as soon as its attempt is outside the window.
      await db.$executeRaw`
      UPDATE agent_channels
      SET synced_events = ${OLD_EVENTS.join(",")},
          events_sync_attempted_at = now() - interval '7 hours'
      WHERE id = ${app.id}`;
      expect(await syncPresenceEvents()).toEqual({ synced: 1, deferred: 0 });
      expect((await syncRow(app.id)).syncedEvents).toBe(BOT_EVENTS.join(","));
    });

    it("two passes racing claim disjoint apps (each app is synced once)", async () => {
      const integrationA = await seedIntegration(ORG, true);
      const integrationB = await seedIntegration(BARE_ORG, true);
      const a = await seedApp(WORKSPACE, integrationA);
      const b = await seedApp(BARE_WORKSPACE, integrationB);

      const [one, two] = await Promise.all([
        syncPresenceEvents(),
        syncPresenceEvents(),
      ]);
      expect(one.synced + two.synced).toBe(2);
      expect(updatesTo(a.externalId)).toHaveLength(1);
      expect(updatesTo(b.externalId)).toHaveLength(1);
    });

    it("an app whose row another transaction holds (the adapters' lease renewal) is waited on, not skipped", async () => {
      // Caught live: the adapter's boot pass ran while its own config poll
      // held the presence rows in the ownership transaction, and a
      // SKIP LOCKED claim silently skipped the app until the next hourly
      // pass. The claim must wait the holder out instead.
      const integrationId = await seedIntegration(ORG, true);
      const app = await seedApp(WORKSPACE, integrationId);

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = db.$transaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE agent_channels
          SET owner_lease_expires_at = now() + interval '1 minute'
          WHERE id = ${app.id}`;
        locked();
        await held;
      });
      await isLocked;

      const pass = syncPresenceEvents();
      await new Promise((r) => setTimeout(r, 200));
      release();
      await holder;
      expect(await pass).toEqual({ synced: 1, deferred: 0 });
      expect(updatesTo(app.externalId)).toHaveLength(1);
    });

    it("each app is edited only with ITS OWN org's credential (two tenants in one pass)", async () => {
      // The multitenancy fence of the sync: the credential comes from the
      // app's own integration, never from whichever org the pass met first.
      const integrationA = await seedIntegration(
        ORG,
        true,
        "xoxe.access-org-a",
      );
      const integrationB = await seedIntegration(
        BARE_ORG,
        true,
        "xoxe.access-org-b",
      );
      const a = await seedApp(WORKSPACE, integrationA);
      const b = await seedApp(BARE_WORKSPACE, integrationB);

      expect(await syncPresenceEvents()).toEqual({ synced: 2, deferred: 0 });
      expect(updatesTo(a.externalId).map((c) => c.token)).toEqual([
        "xoxe.access-org-a",
      ]);
      expect(updatesTo(b.externalId).map((c) => c.token)).toEqual([
        "xoxe.access-org-b",
      ]);
      // And the exports too: no app was ever read with a foreign token.
      for (const call of slack.callsTo("apps.manifest.export")) {
        expect(call.token).toBe(
          call.form.app_id === a.externalId
            ? "xoxe.access-org-a"
            : "xoxe.access-org-b",
        );
      }
    });
  },
);
