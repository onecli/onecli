/**
 * Proof for `20260915002700_purge_slack_gateway_app` — the data migration
 * that erases every row the retired "Connect Slack" gateway integration
 * left behind, so a workspace that connected Slack in the past sees nothing.
 *
 * The migration is plain SQL with no code path of its own, so this suite
 * seeds one of every row shape it names — and a non-Slack control beside
 * each — then applies the migration file verbatim and reads back:
 *
 *  - Slack connections (both scopes) and Slack app configs are gone; the
 *    GitHub twins beside them survive untouched.
 *  - A policy rule whose only target was the Slack app is gone (with its
 *    identity and target rows); a rule whose only target was a Slack
 *    CONNECTION is gone too; a MIXED rule keeps its GitHub target and loses
 *    the Slack one; a GitHub-only rule and the target-less Default Rule
 *    are untouched.
 *  - An availability rule granting [slack, github] keeps github; one
 *    granting only [slack] is deleted (it would grant nothing).
 *  - The channel-side rows (`channel_integrations`, `agent_channels`)
 *    that also say provider = 'slack' are NOT touched: they are the
 *    replacement, not the leftover.
 *  - Running the migration twice is a no-op the second time (deploy retries).
 *
 * `prisma migrate deploy` has already applied this migration to the proof
 * database before the suite runs, so the rows seeded here reproduce the
 * pre-migration state and the file is re-applied by hand: that is exactly
 * what makes the idempotency claim testable.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proofDatabaseUrl } from "../testing/pg-proof.js";

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
let db: Db;

const P = "purge-slack-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const AGENT = `${P}agent`;
const USER = `${P}user`;

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/prisma/migrations/20260915002700_purge_slack_gateway_app/migration.sql",
);

/** Prisma's $executeRawUnsafe takes ONE statement; the file has several. */
const applyMigration = async () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const statements = sql
    .split(/;\s*\n/)
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0);
  expect(statements.length).toBeGreaterThanOrEqual(6);
  for (const statement of statements) {
    await db.$executeRawUnsafe(statement);
  }
};

const rule = (logicalId: string, name: string) => ({
  scope: "workspace" as const,
  workspaceId: WORKSPACE,
  status: "published",
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
});

const cleanup = async () => {
  await db.policyRuleTarget.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleIdentity.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleV2.deleteMany({ where: { logicalId: { startsWith: P } } });
  await db.appAvailabilityRule.deleteMany({ where: { organizationId: ORG } });
  await db.appConnection.deleteMany({
    where: { OR: [{ workspaceId: WORKSPACE }, { organizationId: ORG }] },
  });
  await db.appConfig.deleteMany({
    where: { OR: [{ workspaceId: WORKSPACE }, { organizationId: ORG }] },
  });
  await db.agentChannel.deleteMany({ where: { agentId: AGENT } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.agent.deleteMany({ where: { id: AGENT } });
  await db.workspaceAccess.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: USER } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  await cleanup();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: WORKSPACE, organizationId: ORG },
  });
  await db.user.create({
    data: {
      id: USER,
      email: `${USER}@example.com`,
      externalAuthId: USER,
      name: USER,
    },
  });
  await db.organizationMember.create({
    data: {
      organizationId: ORG,
      userId: USER,
      userEmail: `${USER}@example.com`,
      role: "owner",
    },
  });
  await db.agent.create({
    data: {
      id: AGENT,
      identifier: AGENT,
      name: AGENT,
      workspaceId: WORKSPACE,
      accessToken: `aoc_${AGENT}`,
      kind: "hosted",
      harness: "fake",
    },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await cleanup();
});

describe.skipIf(!PROOF_URL)("purge_slack_gateway_app migration", () => {
  it("erases every gateway-side Slack row, spares its non-Slack twin and the channel rows, and is idempotent", async () => {
    // ── Seed the pre-migration world ────────────────────────────────────
    const slackWs = await db.appConnection.create({
      data: {
        scope: "workspace",
        workspaceId: WORKSPACE,
        provider: "slack",
        status: "connected",
        credentials: "enc:xoxb-old",
      },
    });
    const slackOrg = await db.appConnection.create({
      data: {
        scope: "organization",
        organizationId: ORG,
        provider: "slack",
        status: "connected",
      },
    });
    const githubWs = await db.appConnection.create({
      data: {
        scope: "workspace",
        workspaceId: WORKSPACE,
        provider: "github",
        status: "connected",
      },
    });
    await db.appConfig.create({
      data: { scope: "workspace", workspaceId: WORKSPACE, provider: "slack" },
    });
    await db.appConfig.create({
      data: { scope: "organization", organizationId: ORG, provider: "slack" },
    });
    await db.appConfig.create({
      data: { scope: "workspace", workspaceId: WORKSPACE, provider: "github" },
    });

    // Rules: slack-app-only, slack-connection-only, mixed, github-only.
    await db.policyRuleV2.create({
      data: {
        ...rule(`${P}slack-app-only`, "slack app only"),
        targets: { create: [{ kind: "app", appProvider: "slack" }] },
      },
    });
    await db.policyRuleV2.create({
      data: {
        ...rule(`${P}slack-conn-only`, "slack connection only"),
        targets: {
          create: [
            {
              kind: "connection",
              appConnectionId: slackWs.id,
            },
          ],
        },
      },
    });
    await db.policyRuleV2.create({
      data: {
        ...rule(`${P}mixed`, "slack + github"),
        targets: {
          create: [
            { kind: "app", appProvider: "slack" },
            { kind: "app", appProvider: "github" },
            {
              kind: "connection",
              appConnectionId: slackOrg.id,
            },
          ],
        },
      },
    });
    await db.policyRuleV2.create({
      data: {
        ...rule(`${P}github-only`, "github only"),
        targets: {
          create: [
            {
              kind: "connection",
              appConnectionId: githubWs.id,
            },
          ],
        },
      },
    });
    // The terminal Default Rule: target-less by construction.
    await db.policyRuleV2.create({
      data: {
        ...rule(`${P}default`, "Default Rule"),
        isDefault: true,
        action: "block",
        identities: undefined,
      },
    });

    await db.appAvailabilityRule.create({
      data: {
        organizationId: ORG,
        name: "slack+github",
        providers: ["slack", "github"],
        identities: { create: [{ userId: USER }] },
      },
    });
    await db.appAvailabilityRule.create({
      data: {
        organizationId: ORG,
        name: "slack only",
        providers: ["slack"],
        identities: { create: [{ userId: USER }] },
      },
    });

    // The replacement — channel rows that also say "slack". Must survive.
    const integration = await db.channelIntegration.create({
      data: { organizationId: ORG, provider: "slack", externalId: `${P}team` },
    });
    await db.agentChannel.create({
      data: {
        agentId: AGENT,
        integrationId: integration.id,
        provider: "slack",
        externalId: `${P}app`,
        transport: "events",
        status: "active",
      },
    });

    // ── Apply the migration file verbatim ───────────────────────────────
    await applyMigration();

    // ── Gateway-side Slack rows: gone. Twins: intact. ───────────────────
    const connections = await db.appConnection.findMany({
      where: { OR: [{ workspaceId: WORKSPACE }, { organizationId: ORG }] },
    });
    expect(connections.map((c) => c.provider)).toEqual(["github"]);
    const configs = await db.appConfig.findMany({
      where: { OR: [{ workspaceId: WORKSPACE }, { organizationId: ORG }] },
    });
    expect(configs.map((c) => c.provider)).toEqual(["github"]);

    const rules = await db.policyRuleV2.findMany({
      where: { logicalId: { startsWith: P } },
      include: { targets: true, identities: true },
      orderBy: { logicalId: "asc" },
    });
    const byId = new Map(rules.map((r) => [r.logicalId, r]));
    expect(byId.has(`${P}slack-app-only`)).toBe(false);
    expect(byId.has(`${P}slack-conn-only`)).toBe(false);
    const mixed = byId.get(`${P}mixed`);
    expect(mixed).toBeDefined();
    expect(mixed!.targets.map((t) => t.appProvider ?? t.kind)).toEqual([
      "github",
    ]);
    expect(mixed!.identities).toHaveLength(1);
    expect(byId.get(`${P}github-only`)!.targets).toHaveLength(1);
    expect(byId.get(`${P}default`)).toBeDefined();
    // No orphaned identity/target rows for the deleted rules.
    expect(
      await db.policyRuleIdentity.count({
        where: { rule: { logicalId: { startsWith: `${P}slack-` } } },
      }),
    ).toBe(0);

    const availability = await db.appAvailabilityRule.findMany({
      where: { organizationId: ORG },
      include: { identities: true },
    });
    expect(availability).toHaveLength(1);
    expect(availability[0]!.providers).toEqual(["github"]);
    expect(availability[0]!.identities).toHaveLength(1);

    // ── Channel rows untouched ──────────────────────────────────────────
    expect(
      await db.channelIntegration.count({
        where: { organizationId: ORG, provider: "slack" },
      }),
    ).toBe(1);
    expect(
      await db.agentChannel.count({
        where: { agentId: AGENT, provider: "slack", status: "active" },
      }),
    ).toBe(1);

    // ── Idempotent: a second application changes nothing ────────────────
    // Counted within THIS test's tenant: the pg lane runs files in parallel
    // against one database, so a global count moves under us whenever
    // another suite plants a policy rule between the two snapshots.
    const snapshot = async () => ({
      connections: await db.appConnection.count({
        where: { OR: [{ workspaceId: WORKSPACE }, { organizationId: ORG }] },
      }),
      configs: await db.appConfig.count({
        where: { OR: [{ workspaceId: WORKSPACE }, { organizationId: ORG }] },
      }),
      rules: await db.policyRuleV2.count({
        where: { logicalId: { startsWith: P } },
      }),
      targets: await db.policyRuleTarget.count({
        where: { rule: { logicalId: { startsWith: P } } },
      }),
      availability: await db.appAvailabilityRule.count({
        where: { organizationId: ORG },
      }),
    });
    const before = await snapshot();
    await applyMigration();
    expect(await snapshot()).toEqual(before);
  });
});
