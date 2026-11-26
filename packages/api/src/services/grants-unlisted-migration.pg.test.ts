/**
 * Proof for `20261001160631_grant_unlisted_needs_approval`, the data migration
 * that turns the terminal "everything else" BLOCK of existing customized grant
 * stacks into the needs-approval row the compiler emits today.
 *
 * The pre-migration world is seeded from the REAL compiler with only the
 * terminal reverted to its old shape (a condition-less whole-app block), so the
 * strongest claim is checkable directly: after the migration every converted
 * stack `stackEquals` a fresh compile, i.e. live grants behave exactly like
 * re-saved ones and the next save writes nothing. Around that:
 *
 *  - draft and every published generation convert, each taking ITS OWN
 *    generation's allow-row conditions (and a second agent on the same
 *    connection takes its own), while a stack whose allow rows carry jsonb
 *    `null` (the published form of "no conditions") converts with none;
 *  - the blocked complement, an AWS terminal (`unlisted: "block"`), and a
 *    custom (non-grant) whole-app block are untouched;
 *  - a second application changes nothing (deploy retries).
 *
 * `prisma migrate deploy` has already applied the migration to the proof
 * database, so the file is re-applied by hand over the seeded rows.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proofDatabaseUrl } from "../testing/pg-proof.js";

const PROOF_URL = proofDatabaseUrl();

// Loaded in `beforeAll`, after DATABASE_URL points at the proof database:
// these modules construct the Prisma client on import.
type DbModule = typeof import("@onecli/db");
type Compile = typeof import("./grants-compile");
let db: DbModule["db"];
let Prisma: DbModule["Prisma"];
let compile: Compile;
let RULE_INCLUDE: (typeof import("./policy-service"))["RULE_INCLUDE"];

const P = "grant-unlisted-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const AGENT_A = `${P}agent-a`;
const AGENT_B = `${P}agent-b`;
const CONN_GH = `${P}conn-gh`;
const CONN_AWS = `${P}conn-aws`;

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/prisma/migrations/20261001160631_grant_unlisted_needs_approval/migration.sql",
);

/** One statement; `$executeRawUnsafe` rejects the leading comment block. */
const applyMigration = () =>
  db.$executeRawUnsafe(
    readFileSync(MIGRATION, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n"),
  );

interface StackSeed {
  agentId: string;
  connectionId: string;
  provider: string;
  allow: string[];
  conditions: { repositories: string[] } | null;
  status: "draft" | "published";
  generation: number;
}

const nameBase = (s: StackSeed) => `Grant: ${s.agentId} · ${s.provider}`;

const compiled = (s: StackSeed) =>
  compile.compileConnectionStack(
    nameBase(s),
    s.provider,
    { access: "custom", allow: s.allow, ask: [] },
    s.conditions,
  );

/** The pre-migration rows: today's compile with the terminal reverted to the
 * old whole-app block. Conditions take each status's storage form (a draft
 * omits them, a published snapshot writes jsonb `null`). */
const seedLegacyStack = async (s: StackSeed) => {
  const rows = compiled(s);
  for (const [i, rule] of rows.entries()) {
    const terminal = i === rows.length - 1;
    const conditions = terminal ? null : (rule.conditions ?? null);
    await db.policyRuleV2.create({
      data: {
        scope: "workspace",
        workspaceId: WORKSPACE,
        status: s.status,
        generation: s.generation,
        priority: i + 1,
        isDefault: false,
        enabled: true,
        source: "grant",
        logicalId: `${P}${s.agentId}-${s.provider}-${s.status}-${String(s.generation)}-${String(i)}`,
        name: rule.name,
        action: terminal ? "block" : rule.action,
        requireApproval: terminal ? false : rule.requireApproval,
        ...(conditions !== null
          ? { conditions }
          : s.status === "published"
            ? { conditions: Prisma.JsonNull }
            : {}),
        identities: { create: [{ agentId: s.agentId }] },
        targets: {
          create: [
            {
              kind: "connection",
              appConnectionId: s.connectionId,
              appTools: rule.tools,
            },
          ],
        },
      },
    });
  }
};

const stackRows = (s: StackSeed) =>
  db.policyRuleV2.findMany({
    where: {
      workspaceId: WORKSPACE,
      source: "grant",
      status: s.status,
      generation: s.generation,
      identities: { some: { agentId: s.agentId } },
      targets: { some: { appConnectionId: s.connectionId } },
    },
    include: RULE_INCLUDE,
    orderBy: { priority: "asc" },
  });

const cleanup = async () => {
  await db.policyRuleV2.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.appConnection.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.agent.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db, Prisma } = await import("@onecli/db"));
  compile = await import("./grants-compile");
  ({ RULE_INCLUDE } = await import("./policy-service"));
  await cleanup();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: WORKSPACE, organizationId: ORG },
  });
  for (const id of [AGENT_A, AGENT_B]) {
    await db.agent.create({
      data: {
        id,
        identifier: id,
        name: id,
        workspaceId: WORKSPACE,
        accessToken: `aoc_${id}`,
        kind: "hosted",
        harness: "fake",
      },
    });
  }
  for (const [id, provider] of [
    [CONN_GH, "github"],
    [CONN_AWS, "aws-role"],
  ] as const) {
    await db.appConnection.create({
      data: {
        id,
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

describe.skipIf(!PROOF_URL)("grant_unlisted_needs_approval migration", () => {
  it("converts every non-AWS terminal to today's compile, leaves the rest alone, and is idempotent", async () => {
    const github = {
      connectionId: CONN_GH,
      provider: "github",
      allow: ["get_repo"],
    };
    const converted: StackSeed[] = [
      {
        ...github,
        agentId: AGENT_A,
        conditions: { repositories: ["acme/api"] },
        status: "draft",
        generation: 0,
      },
      {
        ...github,
        agentId: AGENT_A,
        conditions: { repositories: ["old/repo"] },
        status: "published",
        generation: 2,
      },
      {
        ...github,
        agentId: AGENT_A,
        conditions: null,
        status: "published",
        generation: 3,
      },
      {
        ...github,
        agentId: AGENT_B,
        conditions: { repositories: ["b/repo"] },
        status: "draft",
        generation: 0,
      },
    ];
    const aws: StackSeed = {
      agentId: AGENT_A,
      connectionId: CONN_AWS,
      provider: "aws-role",
      allow: ["s3_read_objects"],
      conditions: null,
      status: "draft",
      generation: 0,
    };
    for (const s of [...converted, aws]) await seedLegacyStack(s);
    // A custom (non-grant) whole-app block on the same connection.
    await db.policyRuleV2.create({
      data: {
        scope: "workspace",
        workspaceId: WORKSPACE,
        status: "draft",
        priority: 50,
        source: "custom",
        logicalId: `${P}custom-block`,
        name: "Block GitHub",
        action: "block",
        targets: {
          create: [{ kind: "connection", appConnectionId: CONN_GH }],
        },
      },
    });

    await applyMigration();

    for (const s of converted) {
      const rows = await stackRows(s);
      expect(
        compile.stackEquals(rows, compiled(s)),
        `${s.agentId} ${s.status} gen ${String(s.generation)}`,
      ).toBe(true);
      // The blocked complement is still an explicit block.
      expect(rows.find((r) => r.name.endsWith(": blocked"))).toMatchObject({
        action: "block",
      });
    }
    const awsTerminal = (await stackRows(aws)).at(-1);
    expect(awsTerminal).toMatchObject({
      action: "block",
      requireApproval: false,
    });
    expect(compile.stackEquals(await stackRows(aws), compiled(aws))).toBe(true);
    expect(
      await db.policyRuleV2.findFirst({
        where: { logicalId: `${P}custom-block` },
      }),
    ).toMatchObject({ action: "block", requireApproval: false });

    const snapshot = () =>
      db.policyRuleV2.findMany({
        where: { workspaceId: WORKSPACE },
        select: {
          id: true,
          action: true,
          requireApproval: true,
          conditions: true,
        },
        orderBy: { id: "asc" },
      });
    const before = await snapshot();
    expect(await applyMigration()).toBe(0);
    expect(await snapshot()).toEqual(before);
  });
});
