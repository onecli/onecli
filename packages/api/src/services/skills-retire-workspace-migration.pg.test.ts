/**
 * Proof for `20261018112224_retire_workspace_skills`, the data migration that
 * folds every workspace-tier skill onto the hosted agents that carried it and
 * then pins the tier dead with the two CHECKs.
 *
 * The proof database is already migrated, so the pre-migration world (the
 * three-tier CHECKs, workspace rows) cannot exist in it. Each run therefore
 * happens inside ONE transaction that rebuilds that world, applies the
 * migration's statements, snapshots the result, and rolls everything back:
 * DDL is transactional in Postgres, so nothing leaks to the shared database.
 * The pg project runs files serially, so the table locks taken here block no
 * other suite.
 *
 * What it pins:
 *  - each workspace skill lands on every HOSTED agent of ITS workspace, with
 *    its files, enabled state, and authorship (BYO agents, a sibling
 *    workspace, and another org's agents get nothing from it);
 *  - an agent's own row of the same name is kept, enabled or paused, and
 *    never duplicated (the per-agent unique would refuse it anyway);
 *  - no workspace row and no `workspace_id` value survives, and org rows are
 *    untouched.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { proofDatabaseUrl } from "../testing/pg-proof.js";

const PROOF_URL = proofDatabaseUrl();

// Loaded in `beforeAll`, after DATABASE_URL points at the proof database:
// the module constructs the Prisma client on import.
let db: (typeof import("@onecli/db"))["db"];

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/prisma/migrations/20261018112224_retire_workspace_skills/migration.sql",
);

/** The migration as separate statements: `$executeRawUnsafe` runs one at a
 * time. Comment lines go first (they contain semicolons); no statement holds
 * one inside a literal. */
const statements = () =>
  readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");

/** The CHECKs as they stood before this migration (three tiers). */
const PRE_MIGRATION_CHECKS = [
  `ALTER TABLE "skills" DROP CONSTRAINT "skills_one_owner"`,
  `ALTER TABLE "skills" DROP CONSTRAINT "skills_scope_coherent"`,
  `ALTER TABLE "skills" ADD CONSTRAINT "skills_one_owner"
     CHECK (num_nonnulls("agent_id", "workspace_id", "organization_id") = 1)`,
  `ALTER TABLE "skills" ADD CONSTRAINT "skills_scope_coherent" CHECK (
     (("scope" = 'agent') = ("agent_id" IS NOT NULL)) AND
     (("scope" = 'workspace') = ("workspace_id" IS NOT NULL)) AND
     (("scope" = 'organization') = ("organization_id" IS NOT NULL)))`,
];

const P = "skl-retire-";
const ORG = `${P}org`;
const FOREIGN_ORG = `${P}forg`;
const WORKSPACE = `${P}ws`;
const SIBLING_WORKSPACE = `${P}ws-sibling`;
const FOREIGN_WORKSPACE = `${P}ws-foreign`;
const AUTHOR = `${P}author@example.com`;
const AUTHORED_AT = new Date("2026-09-01T10:00:00.000Z");

/** Agents by role; the id doubles as the label in the snapshot. */
const AGENTS = {
  plain: { workspaceId: WORKSPACE, kind: "hosted" },
  ownEnabled: { workspaceId: WORKSPACE, kind: "hosted" },
  ownPaused: { workspaceId: WORKSPACE, kind: "hosted" },
  byo: { workspaceId: WORKSPACE, kind: "byo" },
  sibling: { workspaceId: SIBLING_WORKSPACE, kind: "hosted" },
  foreign: { workspaceId: FOREIGN_WORKSPACE, kind: "hosted" },
} as const;
type AgentRole = keyof typeof AGENTS;
const agentId = (role: AgentRole) => `${P}${role}`;

interface SkillSnapshot {
  owner: string;
  scope: string;
  name: string;
  content: string;
  enabled: boolean;
  workspaceId: string | null;
  createdByEmail: string | null;
  createdAt: Date;
  files: { path: string; content: string }[];
}

/** Thrown to roll the proof transaction back once the snapshot is taken. */
class RolledBack extends Error {}

/** Builds the pre-migration world, migrates it, and returns every skill row
 * this suite owns, all inside one transaction that is then rolled back. */
const migrateSeededWorld = async (): Promise<SkillSnapshot[]> => {
  let snapshot: SkillSnapshot[] = [];
  await expect(
    db.$transaction(
      async (tx) => {
        for (const statement of PRE_MIGRATION_CHECKS) {
          await tx.$executeRawUnsafe(statement);
        }
        for (const id of [ORG, FOREIGN_ORG]) {
          await tx.organization.create({ data: { id, name: id, slug: id } });
        }
        for (const [id, organizationId] of [
          [WORKSPACE, ORG],
          [SIBLING_WORKSPACE, ORG],
          [FOREIGN_WORKSPACE, FOREIGN_ORG],
        ] as const) {
          await tx.workspace.create({ data: { id, name: id, organizationId } });
        }
        for (const [role, agent] of Object.entries(AGENTS)) {
          const id = `${P}${role}`;
          await tx.agent.create({
            data: {
              id,
              identifier: id,
              name: id,
              accessToken: `aoc_${id}`,
              workspaceId: agent.workspaceId,
              kind: agent.kind,
              ...(agent.kind === "hosted" && { harness: "fake" }),
            },
          });
        }

        // The workspace tier being retired.
        await tx.skill.create({
          data: {
            scope: "workspace",
            workspaceId: WORKSPACE,
            name: "deploy",
            description: "how we ship",
            content: "WORKSPACE BODY",
            createdByEmail: AUTHOR,
            createdAt: AUTHORED_AT,
            files: {
              create: [{ path: "references/api.md", content: "REF BODY" }],
            },
          },
        });
        await tx.skill.create({
          data: {
            scope: "workspace",
            workspaceId: WORKSPACE,
            name: "paused-ws",
            description: "d",
            content: "PAUSED BODY",
            enabled: false,
          },
        });
        await tx.skill.create({
          data: {
            scope: "workspace",
            workspaceId: FOREIGN_WORKSPACE,
            name: "foreign-ws",
            description: "d",
            content: "FOREIGN BODY",
          },
        });
        // Agents' own rows of the same name, and an org row that must not move.
        await tx.skill.create({
          data: {
            scope: "agent",
            agentId: agentId("ownEnabled"),
            name: "deploy",
            description: "d",
            content: "OWN ENABLED BODY",
          },
        });
        await tx.skill.create({
          data: {
            scope: "agent",
            agentId: agentId("ownPaused"),
            name: "deploy",
            description: "d",
            content: "OWN PAUSED BODY",
            enabled: false,
          },
        });
        await tx.skill.create({
          data: {
            scope: "organization",
            organizationId: ORG,
            name: "org-wide",
            description: "d",
            content: "ORG BODY",
          },
        });

        for (const statement of statements()) {
          await tx.$executeRawUnsafe(statement);
        }

        const rows = await tx.skill.findMany({
          where: {
            OR: [
              { agent: { identifier: { startsWith: P } } },
              { organizationId: { startsWith: P } },
              { workspaceId: { startsWith: P } },
            ],
          },
          select: {
            scope: true,
            agentId: true,
            workspaceId: true,
            organizationId: true,
            name: true,
            content: true,
            enabled: true,
            createdByEmail: true,
            createdAt: true,
            files: { select: { path: true, content: true } },
          },
        });
        snapshot = rows.map((row) => ({
          owner: (row.agentId ?? row.organizationId ?? "none").slice(P.length),
          scope: row.scope,
          name: row.name,
          content: row.content,
          enabled: row.enabled,
          workspaceId: row.workspaceId,
          createdByEmail: row.createdByEmail,
          createdAt: row.createdAt,
          files: row.files,
        }));
        throw new RolledBack();
      },
      { timeout: 30_000 },
    ),
  ).rejects.toBeInstanceOf(RolledBack);
  return snapshot;
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
});

describe.skipIf(!PROOF_URL)("retire_workspace_skills migration", () => {
  it("copies each workspace skill onto its own workspace's hosted agents, keeps own rows, and leaves no workspace tier", async () => {
    const rows = await migrateSeededWorld();
    const find = (owner: string, name: string) =>
      rows.find((row) => row.owner === owner && row.name === name);

    expect(
      rows
        .map((row) => `${row.owner}:${row.scope}:${row.name}:${row.enabled}`)
        .sort(),
    ).toEqual([
      "foreign:agent:foreign-ws:true",
      "org:organization:org-wide:true",
      "ownEnabled:agent:deploy:true",
      "ownEnabled:agent:paused-ws:false",
      "ownPaused:agent:deploy:false",
      "ownPaused:agent:paused-ws:false",
      "plain:agent:deploy:true",
      "plain:agent:paused-ws:false",
    ]);
    // Nothing still points at a workspace (the CHECK pins it from here on).
    expect(rows.filter((row) => row.workspaceId !== null)).toEqual([]);

    // The copy is the workspace row: body, files, authorship.
    expect(find("plain", "deploy")).toMatchObject({
      content: "WORKSPACE BODY",
      createdByEmail: AUTHOR,
      createdAt: AUTHORED_AT,
      files: [{ path: "references/api.md", content: "REF BODY" }],
    });
    // Own rows win, enabled or paused, and gain no copied files.
    expect(find("ownEnabled", "deploy")).toMatchObject({
      content: "OWN ENABLED BODY",
      files: [],
    });
    expect(find("ownPaused", "deploy")).toMatchObject({
      content: "OWN PAUSED BODY",
      enabled: false,
      files: [],
    });
    expect(find("foreign", "foreign-ws")?.content).toBe("FOREIGN BODY");
  });
});
