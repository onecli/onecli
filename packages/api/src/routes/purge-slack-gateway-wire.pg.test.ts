/**
 * Acceptance walk for the Slack purge over the REAL public interfaces — the
 * routes the dashboard reads, through `createApiApp`, with a signed-in
 * owner. It plays the actual upgrade story of a workspace that had
 * "connected Slack" through the gateway before this change:
 *
 *   before the migration: GET /v1/connections lists the Slack row, the
 *   org's GET /v1/org/policy/rules lists the rule that governed it, and
 *   GET /v1/apps offers no Slack app to connect (the registry entry went
 *   earlier in this PR);
 *   after the migration:  the same three reads show nothing Slack-shaped,
 *   the GitHub connection and its rule are exactly as they were, and the
 *   agent's live Slack presence still reads `active` on
 *   GET /v1/agents/:id/channels — the replacement is untouched.
 *
 * `purge-slack-gateway.pg.test.ts` proves the migration row by row; this
 * suite proves what the person at the dashboard sees. Together they are
 * the acceptance path short of clicking through the deployed UI.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { proofDatabaseUrl } from "../testing/pg-proof.js";

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
let db: Db;
let app: ReturnType<typeof import("../app").createApiApp>;

const P = "purgewire-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const OWNER = `${P}owner`;
const AGENT = `${P}agent`;
const SELF_URL = "https://api.purgewire.test";

let currentSession: { id: string; email: string } | null = null;
const authed = { headers: { "x-workspace-id": WORKSPACE } };

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/prisma/migrations/20260915002700_purge_slack_gateway_app/migration.sql",
);
const applyMigration = async () => {
  const statements = readFileSync(MIGRATION, "utf8")
    .split(/;\s*\n/)
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0);
  for (const statement of statements) await db.$executeRawUnsafe(statement);
};

const cleanup = async () => {
  await db.policyRuleTarget.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleIdentity.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleV2.deleteMany({ where: { logicalId: { startsWith: P } } });
  await db.appConnection.deleteMany({
    where: { OR: [{ workspaceId: WORKSPACE }, { organizationId: ORG }] },
  });
  await db.agentChannel.deleteMany({ where: { agentId: AGENT } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.agent.deleteMany({ where: { id: AGENT } });
  await db.workspaceAccess.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: OWNER } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  ({ db } = await import("@onecli/db"));
  const providers = await import("../providers");
  providers.initSelfUrl(SELF_URL);
  const { createApiApp } = await import("../app");
  app = createApiApp(
    { getSession: async () => currentSession },
    { selfUrl: SELF_URL },
  );

  await cleanup();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Purge Wire", organizationId: ORG },
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
  await db.agent.create({
    data: {
      id: AGENT,
      identifier: AGENT,
      name: "Purge Wire Agent",
      workspaceId: WORKSPACE,
      accessToken: `aoc_${AGENT}`,
      kind: "hosted",
      harness: "fake",
    },
  });
  currentSession = { id: OWNER, email: `${OWNER}@example.com` };
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await cleanup();
});

const providersOf = async (path: string): Promise<string[]> => {
  const res = await app.request(path, authed);
  expect(res.status).toBe(200);
  const rows = (await res.json()) as { provider: string }[];
  return rows.map((r) => r.provider).sort();
};

describe.skipIf(!PROOF_URL)(
  "the dashboard of a workspace that connected Slack through the gateway",
  () => {
    it("lists the Slack row before the migration and nothing Slack-shaped after; GitHub and the agent's Slack app are untouched", async () => {
      // ── A workspace that connected Slack AND GitHub through the gateway,
      //    and one org policy rule per connection, plus the agent's own
      //    Slack app (the replacement).
      const slackConn = await db.appConnection.create({
        data: {
          scope: "workspace",
          workspaceId: WORKSPACE,
          provider: "slack",
          status: "connected",
          label: "Acme Slack",
          credentials: "enc:xoxb-legacy",
        },
      });
      const githubConn = await db.appConnection.create({
        data: {
          scope: "workspace",
          workspaceId: WORKSPACE,
          provider: "github",
          status: "connected",
          label: "octocat",
        },
      });
      const ruleFor = (logicalId: string, name: string, connectionId: string) =>
        db.policyRuleV2.create({
          data: {
            scope: "organization",
            organizationId: ORG,
            status: "draft",
            generation: 1,
            priority: 10,
            isDefault: false,
            enabled: true,
            source: "custom",
            logicalId,
            name,
            action: "allow",
            requireApproval: false,
            identities: { create: [{ agentId: AGENT }] },
            targets: {
              create: [{ kind: "connection", appConnectionId: connectionId }],
            },
          },
        });
      await ruleFor(`${P}slack-rule`, "Slack for the agent", slackConn.id);
      await ruleFor(`${P}github-rule`, "GitHub for the agent", githubConn.id);
      const integration = await db.channelIntegration.create({
        data: {
          organizationId: ORG,
          provider: "slack",
          externalId: `${P}team`,
        },
      });
      await db.agentChannel.create({
        data: {
          agentId: AGENT,
          integrationId: integration.id,
          provider: "slack",
          externalId: `${P}app`,
          identityName: "donna",
          transport: "events",
          status: "active",
        },
      });

      // ── BEFORE: what the dashboard reads today on a not-yet-migrated DB.
      expect(await providersOf("/v1/connections")).toEqual(["github", "slack"]);
      const rulesBefore = (await (
        await app.request("/v1/org/policy/rules", authed)
      ).json()) as { name: string }[];
      expect(rulesBefore.map((r) => r.name).sort()).toEqual([
        "GitHub for the agent",
        "Slack for the agent",
      ]);
      // The catalog already has no Slack app to (re)connect — the registry
      // entry left earlier in this PR — so the row above is an orphan.
      const appsRes = await app.request("/v1/apps", authed);
      expect(appsRes.status).toBe(200);
      const apps = (await appsRes.json()) as { id: string }[];
      expect(apps.some((a) => a.id === "slack")).toBe(false);
      expect(apps.some((a) => a.id === "github")).toBe(true);

      // ── The upgrade: the migration the deploy runs before the rollout.
      await applyMigration();

      // ── AFTER: nothing Slack-shaped; GitHub exactly as before.
      expect(await providersOf("/v1/connections")).toEqual(["github"]);
      const connsAfter = (await (
        await app.request("/v1/connections", authed)
      ).json()) as { id: string; label: string | null }[];
      expect(connsAfter).toEqual([
        expect.objectContaining({ id: githubConn.id, label: "octocat" }),
      ]);
      const rulesAfter = (await (
        await app.request("/v1/org/policy/rules", authed)
      ).json()) as { name: string; targets: { kind: string }[] }[];
      expect(rulesAfter.map((r) => r.name)).toEqual(["GitHub for the agent"]);
      expect(rulesAfter[0]!.targets).toHaveLength(1);
      // A direct read of the deleted row is a 404, not a disclosure.
      const gone = await app.request(`/v1/connections/${slackConn.id}`, authed);
      expect(gone.status).toBe(404);

      // ── The agent's Slack app — its real Slack access — is untouched.
      const channels = await app.request(
        `/v1/agents/${AGENT}/channels`,
        authed,
      );
      expect(channels.status).toBe(200);
      const { presences } = (await channels.json()) as {
        presences: { provider: string; status: string }[];
      };
      expect(presences).toEqual([
        expect.objectContaining({ provider: "slack", status: "active" }),
      ]);
    });
  },
);
