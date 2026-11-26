/**
 * Proof for `20261011191656_grant_default_unlisted_needs_approval`: an
 * existing full-access attach becomes exactly what a fresh default attach
 * writes (AWS included), while customized and disabled grants are untouched,
 * and a re-run is a no-op. The migration is re-applied by hand over seeded
 * rows.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proofDatabaseUrl } from "../testing/pg-proof.js";
import type { ConnectionGrantInput } from "../validations/grants";
import { catalogToolIds } from "../apps/app-permissions/validate";

const PROOF_URL = proofDatabaseUrl();

type DbModule = typeof import("@onecli/db");
let db: DbModule["db"];
let compile: typeof import("./grants-compile");
let RULE_INCLUDE: (typeof import("./policy-service"))["RULE_INCLUDE"];

const P = "grant-default-";

/** What THIS migration writes (the default as of 2026-10-11: every catalog
 * tool allowed, unlisted needs approval). The live default moved on later
 * (writes need approval), but a migration's output is fixed history. */
const migratedGrant = (provider: string): ConnectionGrantInput => ({
  access: "custom",
  allow: [...catalogToolIds(provider)].sort(),
  ask: [],
  otherReads: "ask",
  otherWrites: "ask",
});
const WORKSPACE = `${P}ws`;
const AGENT = `${P}agent`;

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/prisma/migrations/20261011191656_grant_default_unlisted_needs_approval/migration.sql",
);
const applyMigration = () =>
  db.$executeRawUnsafe(
    readFileSync(MIGRATION, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n"),
  );

let priority = 1;
type Copy = { status: "draft" | "published"; generation: number };
const DRAFT: Copy = { status: "draft", generation: 0 };
const seed = async (
  connectionId: string,
  input: ConnectionGrantInput,
  copy: Copy = DRAFT,
  conditions: { repositories: string[] } | null = null,
) => {
  const provider = connectionId.slice(P.length);
  const rows = compile.compileConnectionStack(
    `G ${provider}`,
    provider,
    input,
    conditions,
  );
  for (const rule of rows) {
    await db.policyRuleV2.create({
      data: {
        scope: "workspace",
        workspaceId: WORKSPACE,
        ...copy,
        priority: priority++,
        source: "grant",
        name: rule.name,
        action: rule.action,
        requireApproval: rule.requireApproval,
        ...(rule.conditions ? { conditions: rule.conditions } : {}),
        identities: { create: [{ agentId: AGENT }] },
        targets: {
          create: [
            {
              kind: "connection",
              appConnectionId: connectionId,
              appTools: rule.tools,
            },
          ],
        },
      },
    });
  }
};

const stack = (connectionId: string, copy: Copy = DRAFT) =>
  db.policyRuleV2.findMany({
    where: {
      workspaceId: WORKSPACE,
      ...copy,
      targets: { some: { appConnectionId: connectionId } },
    },
    include: RULE_INCLUDE,
    orderBy: { priority: "asc" },
  });

const cleanup = async () => {
  await db.policyRuleV2.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.appConnection.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.agent.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: `${P}org` } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  compile = await import("./grants-compile");
  ({ RULE_INCLUDE } = await import("./policy-service"));
  await cleanup();
  await db.organization.create({ data: { id: `${P}org`, name: P, slug: P } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: WORKSPACE, organizationId: `${P}org` },
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
  for (const provider of ["github", "gitlab", "linear", "notion", "aws-role"]) {
    await db.appConnection.create({
      data: {
        id: `${P}${provider}`,
        scope: "workspace",
        workspaceId: WORKSPACE,
        provider,
        status: "connected",
      },
    });
  }
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await cleanup();
});

describe.skipIf(!PROOF_URL)(
  "grant_default_unlisted_needs_approval migration",
  () => {
    it("converts full access to the default (AWS included), leaves customized grants, and is idempotent", async () => {
      await seed(`${P}github`, { access: "full" });
      await seed(`${P}aws-role`, { access: "full" });
      const custom: ConnectionGrantInput = {
        access: "custom",
        allow: ["create_issue"],
        ask: [],
        otherReads: "allow",
        otherWrites: "allow",
      };
      await seed(`${P}linear`, custom);
      // A disabled row injects nothing: converting it would add an ENABLED
      // approval row that injects, so it must stay exactly as it is.
      await seed(`${P}notion`, { access: "full" });
      await db.policyRuleV2.updateMany({
        where: { targets: { some: { appConnectionId: `${P}notion` } } },
        data: { enabled: false },
      });

      await applyMigration();

      for (const provider of ["github", "aws-role"]) {
        expect(
          compile.stackEquals(
            await stack(`${P}${provider}`),
            compile.compileConnectionStack(
              `G ${provider}`,
              provider,
              migratedGrant(provider),
            ),
          ),
          provider,
        ).toBe(true);
      }
      expect(
        compile.stackEquals(
          await stack(`${P}linear`),
          compile.compileConnectionStack("G linear", "linear", custom),
        ),
      ).toBe(true);
      const disabled = await stack(`${P}notion`);
      expect(
        disabled.map((r) => [r.enabled, r.targets[0]?.appTools.length]),
      ).toEqual([[false, 0]]);

      expect(await applyMigration()).toBe(0);
    });

    it("converts published copies too, each keeping its resource restriction", async () => {
      // The gateway reads the latest published generation; older ones are
      // rollback targets. Both must convert, with their own conditions.
      const live: Copy = { status: "published", generation: 5 };
      const rollback: Copy = { status: "published", generation: 4 };
      const repos = { repositories: ["acme/api"] };
      await seed(`${P}gitlab`, { access: "full" }, live, repos);
      await seed(`${P}gitlab`, { access: "full" }, rollback, null);

      await applyMigration();

      for (const [copy, conditions] of [
        [live, repos],
        [rollback, null],
      ] as const) {
        const rows = await stack(`${P}gitlab`, copy);
        const expected = compile.compileConnectionStack(
          "G gitlab",
          "gitlab",
          migratedGrant("gitlab"),
          conditions,
        );
        expect(compile.stackEquals(rows, expected), copy.status).toBe(true);
      }
      // Both rows of the live copy carry the restriction, approval row included.
      for (const row of await stack(`${P}gitlab`, live)) {
        expect(row.conditions).toEqual(repos);
      }
    });
  },
);
