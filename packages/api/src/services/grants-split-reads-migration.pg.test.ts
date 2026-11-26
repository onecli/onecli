/**
 * Proof for `20261101084114_grant_split_default_other_reads`: an existing
 * customized grant whose one "everything else" row holds every unlisted
 * request for approval, on a catalog audited for unlisted reads, becomes
 * exactly what the compiler writes today for Other reads = allow, Other
 * writes = ask. Checked the strong way: after the migration each converted
 * stack `stackEquals` a fresh compile, so the gateway behaves like a re-save
 * and the next save writes nothing. Around that:
 *
 *  - draft and every published generation convert, each with ITS OWN
 *    conditions, and a published copy re-created after the cutoff converts
 *    because its rule (logical id) first appeared before it;
 *  - a stack named with the pre-August em dash converts too;
 *  - a rule first written after the split default shipped (the user's own
 *    choice), a catalog not
 *    audited for reads (Cloudflare), AWS's block terminal, an already split
 *    stack, a disabled row, and a terminal the policy editor gave a second
 *    agent are untouched (the last one used to abort the whole migration);
 *  - a second application changes nothing (deploy retries);
 *  - a grant save racing the migration waits for it, and lands exactly its
 *    own stack (no orphan "all other reads" row above it).
 *
 * `prisma migrate deploy` has already applied the migration to the proof
 * database, so the file is re-applied by hand over the seeded rows.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deferred,
  proofDatabaseUrl,
  waitForLockWaiters,
} from "../testing/pg-proof.js";
import type { ConnectionGrantInput } from "../validations/grants";

const PROOF_URL = proofDatabaseUrl();

type DbModule = typeof import("@onecli/db");
let db: DbModule["db"];
let Prisma: DbModule["Prisma"];
let compile: typeof import("./grants-compile");
let grants: typeof import("./grants-service");
let RULE_INCLUDE: (typeof import("./policy-service"))["RULE_INCLUDE"];

const P = "grant-split-reads-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const AGENT_A = `${P}agent-a`;
const AGENT_B = `${P}agent-b`;
const AGENT_C = `${P}agent-c`;
const CONN_ATTIO = `${P}conn-attio`;
const CONN_CF = `${P}conn-cf`;
const CONN_AWS = `${P}conn-aws`;

const BEFORE = new Date("2026-10-12T04:09:26Z");
const AFTER = new Date("2026-10-31T19:43:12Z");

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/prisma/migrations/20261101084114_grant_split_default_other_reads/migration.sql",
);

/** The migration's two statements (the lock, then the conversion), comment
 * lines dropped: `$executeRawUnsafe` runs one statement at a time. No
 * statement holds a `;` inside a literal. */
const [LOCK, CONVERT] = readFileSync(MIGRATION, "utf8")
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((statement) => statement.trim())
  .filter((statement) => statement !== "");

/** As `prisma migrate deploy` runs it: one transaction. Resolves to the
 * number of stacks converted (the rows the final insert wrote). `pause` runs
 * after the lock is taken, before anything is read. */
const applyMigration = (pause?: () => Promise<void>) =>
  db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(LOCK ?? "");
    await pause?.();
    return tx.$executeRawUnsafe(CONVERT ?? "");
  });

interface StackSeed {
  key: string;
  agentId: string;
  connectionId: string;
  provider: string;
  conditions: { repositories: string[] } | null;
  status: "draft" | "published";
  generation: number;
  /** created_at of every row of this copy. */
  createdAt: Date;
  /** Rule identity shared across a stack's copies (draft + generations). */
  lineage: string;
  otherReads?: "allow" | "ask";
  enabled?: boolean;
  /** The separator stacks were written with before August: " — ". */
  emDash?: boolean;
}

const nameBase = (s: StackSeed) => `Grant: ${s.agentId} · ${s.provider}`;

/** One read tool per catalog, so each stack has an allowed row. */
const READ_TOOL: Record<string, string> = {
  attio: "get_record",
  cloudflare: "list_zones",
  "aws-role": "s3_read_objects",
};

const grant = (
  otherReads: "allow" | "ask",
  provider: string,
): ConnectionGrantInput => ({
  access: "custom",
  allow: [READ_TOOL[provider] ?? "get_record"],
  ask: [],
  otherReads,
  otherWrites: provider === "aws-role" ? "never" : "ask",
});

const compiled = (s: StackSeed, otherReads: "allow" | "ask") =>
  compile.compileConnectionStack(
    nameBase(s),
    s.provider,
    grant(otherReads, s.provider),
    s.conditions,
  );

/** Seed one copy of a stack as the compiler wrote it with `otherReads`
 * (default ask: the legacy single terminal). */
const seed = async (s: StackSeed) => {
  const rows = compiled(s, s.otherReads ?? "ask");
  for (const [i, rule] of rows.entries()) {
    const conditions = rule.conditions ?? null;
    const name = s.emDash
      ? rule.name.replace(`${nameBase(s)}: `, `${nameBase(s)} — `)
      : rule.name;
    await db.policyRuleV2.create({
      data: {
        scope: "workspace",
        workspaceId: WORKSPACE,
        status: s.status,
        generation: s.generation,
        priority: i + 1,
        isDefault: false,
        enabled: s.enabled ?? true,
        source: "grant",
        logicalId: `${P}${s.lineage}-${String(i)}`,
        name,
        action: rule.action,
        requireApproval: rule.requireApproval,
        createdAt: s.createdAt,
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
              ...(rule.method ? { method: rule.method } : {}),
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

const cleanupRules = () =>
  db.policyRuleV2.deleteMany({ where: { workspaceId: WORKSPACE } });

const cleanup = async () => {
  await cleanupRules();
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
  grants = await import("./grants-service");
  ({ RULE_INCLUDE } = await import("./policy-service"));
  await cleanup();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: WORKSPACE, organizationId: ORG },
  });
  for (const id of [AGENT_A, AGENT_B, AGENT_C]) {
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
    [CONN_ATTIO, "attio"],
    [CONN_CF, "cloudflare"],
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

describe.skipIf(!PROOF_URL)("grant_split_default_other_reads migration", () => {
  it("converts only catalogs that are still audited for unlisted reads", async () => {
    // A migration is fixed history: a catalog opting in later never joins
    // its snapshot. Only the other direction is a safety question: a catalog
    // that loses its opt-in (a credential-returning GET found) must not stay
    // in a migration that has not run everywhere yet.
    const { getAppPermissionDefinitions } =
      await import("../apps/app-permissions");
    const audited = new Set(
      getAppPermissionDefinitions()
        .filter((d) => d.unlistedReads === "allow")
        .map((d) => d.provider),
    );
    const sql = readFileSync(MIGRATION, "utf8");
    const values = sql.slice(
      sql.indexOf("audited(provider) AS ("),
      sql.indexOf("first_seen AS ("),
    );
    const snapshot = [...values.matchAll(/\('([^']+)'\)/g)].map((m) => m[1]);
    expect(snapshot.length).toBeGreaterThan(0);
    expect(snapshot.filter((p) => p === undefined || !audited.has(p))).toEqual(
      [],
    );
  });

  it("splits legacy terminals on audited catalogs into today's compile, leaves the rest alone, and is idempotent", async () => {
    const attio = {
      agentId: AGENT_A,
      connectionId: CONN_ATTIO,
      provider: "attio",
      lineage: "a-attio",
    };
    const converted: StackSeed[] = [
      {
        ...attio,
        key: "draft",
        conditions: { repositories: ["draft"] },
        status: "draft",
        generation: 0,
        createdAt: BEFORE,
      },
      {
        ...attio,
        key: "old published",
        conditions: null,
        status: "published",
        generation: 2,
        createdAt: BEFORE,
      },
      {
        // Re-published after the cutoff: its rule is still the old one.
        ...attio,
        key: "republished",
        conditions: { repositories: ["live"] },
        status: "published",
        generation: 3,
        createdAt: AFTER,
      },
      {
        // Written before the August copy sweep: "<base> — everything else".
        key: "em dash",
        agentId: AGENT_C,
        connectionId: CONN_ATTIO,
        provider: "attio",
        lineage: "c-attio",
        conditions: null,
        status: "draft",
        generation: 0,
        createdAt: BEFORE,
        emDash: true,
      },
    ];
    const untouched: StackSeed[] = [
      {
        // First written after the cutoff: one ask terminal is the user's choice.
        key: "user choice",
        agentId: AGENT_B,
        connectionId: CONN_ATTIO,
        provider: "attio",
        lineage: "b-attio",
        conditions: null,
        status: "draft",
        generation: 0,
        createdAt: AFTER,
      },
      {
        key: "unaudited",
        agentId: AGENT_A,
        connectionId: CONN_CF,
        provider: "cloudflare",
        lineage: "a-cf",
        conditions: null,
        status: "draft",
        generation: 0,
        createdAt: BEFORE,
      },
      {
        key: "aws",
        agentId: AGENT_A,
        connectionId: CONN_AWS,
        provider: "aws-role",
        lineage: "a-aws",
        conditions: null,
        status: "draft",
        generation: 0,
        createdAt: BEFORE,
      },
      {
        key: "already split",
        agentId: AGENT_B,
        connectionId: CONN_ATTIO,
        provider: "attio",
        lineage: "b-attio-split",
        conditions: null,
        status: "published",
        generation: 2,
        createdAt: BEFORE,
        otherReads: "allow",
      },
      {
        key: "disabled",
        agentId: AGENT_B,
        connectionId: CONN_ATTIO,
        provider: "attio",
        lineage: "b-attio-off",
        conditions: null,
        status: "published",
        generation: 3,
        createdAt: BEFORE,
        enabled: false,
      },
      {
        // Its terminal gets a second agent below, the way the policy editor
        // can: no compiled grant any more, so it stays as it is.
        key: "two agents",
        agentId: AGENT_B,
        connectionId: CONN_ATTIO,
        provider: "attio",
        lineage: "b-attio-shared",
        conditions: null,
        status: "published",
        generation: 4,
        createdAt: BEFORE,
      },
    ];
    for (const s of [...converted, ...untouched]) await seed(s);
    const shared = await db.policyRuleV2.findFirstOrThrow({
      where: { logicalId: { startsWith: `${P}b-attio-shared-` } },
      orderBy: { priority: "desc" },
    });
    await db.policyRuleIdentity.create({
      data: { ruleId: shared.id, agentId: AGENT_A },
    });

    const shape = () =>
      db.policyRuleV2.findMany({
        where: { workspaceId: WORKSPACE },
        select: {
          id: true,
          name: true,
          action: true,
          requireApproval: true,
          priority: true,
          targets: { select: { method: true, appTools: true } },
        },
        orderBy: { id: "asc" },
      });
    const untouchedBefore = await Promise.all(untouched.map(stackRows));

    expect(await applyMigration()).toBe(converted.length);

    for (const s of converted) {
      const rows = await stackRows(s);
      // Behaviour is the compile's. Only the two catch-alls are renamed, so an
      // em-dash stack keeps its old label on the other rows until its next
      // save rewrites them (`stackEquals` compares names, nothing else does).
      const relabelled = rows.map((r) => ({
        ...r,
        name: r.name.replace(" — ", ": "),
      }));
      expect(compile.stackEquals(relabelled, compiled(s, "allow")), s.key).toBe(
        true,
      );
      expect(rows.at(-1), s.key).toMatchObject({
        name: `${nameBase(s)}: all other reads`,
        action: "allow",
        requireApproval: false,
      });
      // The read-back intent is the new default, and a save writes nothing.
      expect(compile.stackToGrant(rows, s.provider), s.key).toMatchObject({
        otherReads: "allow",
        otherWrites: "ask",
      });
    }
    // Untouched stacks: identical rows (priorities may double, order holds).
    for (const [i, s] of untouched.entries()) {
      const rows = await stackRows(s);
      const before = untouchedBefore[i] ?? [];
      expect(
        rows.map((r) => [r.id, r.name, r.action, r.requireApproval]),
        s.key,
      ).toEqual(before.map((r) => [r.id, r.name, r.action, r.requireApproval]));
      expect(
        rows.map((r) => r.targets[0]?.method ?? null),
        s.key,
      ).toEqual(before.map((r) => r.targets[0]?.method ?? null));
    }

    const after = await shape();
    expect(await applyMigration()).toBe(0);
    expect(await shape()).toEqual(after);
  });

  it("holds a racing grant save until it commits, so the save lands its own stack", async () => {
    await cleanupRules();
    // The save is the real service; its plan gate is not under test. Under
    // the CI cloud env that slot fails loudly unless injected (the same
    // permissive default the grants suites use).
    const providers = await import("../providers");
    providers.initRuleActionGate({ assertAllowed: async () => {} });
    const legacy: StackSeed = {
      key: "legacy",
      agentId: AGENT_A,
      connectionId: CONN_ATTIO,
      provider: "attio",
      lineage: "race",
      conditions: null,
      status: "draft",
      generation: 0,
      createdAt: BEFORE,
    };
    await seed(legacy);
    // A rule after the stack, so the save appends past it: an orphan row the
    // migration wrote for the replaced stack would land ABOVE the new one.
    await db.policyRuleV2.create({
      data: {
        scope: "workspace",
        workspaceId: WORKSPACE,
        status: "draft",
        generation: 0,
        priority: 10,
        source: "custom",
        name: `${P}custom`,
        action: "allow",
        targets: {
          create: [{ kind: "network", hostPattern: "example.com" }],
        },
      },
    });
    const saved: ConnectionGrantInput = {
      // A real change (a second read tool), or the save is a no-op that
      // never reaches the lock and the proof would pass vacuously.
      access: "custom",
      allow: ["get_record", "list_records"],
      ask: [],
      otherReads: "ask",
      otherWrites: "ask",
    };

    const locked = deferred();
    const hold = deferred();
    const migration = applyMigration(async () => {
      locked.release();
      await hold.promise;
    });
    await locked.promise;
    const save = grants.setConnectionGrant(
      { workspaceId: WORKSPACE, organizationId: ORG },
      AGENT_A,
      CONN_ATTIO,
      saved,
      null,
    );
    try {
      // A save that fails before reaching the lock must fail this test, not
      // time it out waiting for a lock waiter that never comes.
      await Promise.race([
        waitForLockWaiters(db, { queryLike: "%policy_rules_v2%" }),
        save.then(() => {
          throw new Error("the save finished without waiting for the lock");
        }),
      ]);
    } finally {
      hold.release();
    }
    expect(await migration).toBe(1);
    expect((await save).changed).toBe(true);

    // The save replaced the converted draft whole: exactly the stack it
    // compiled, nothing left over from the migration.
    expect(
      compile.stackEquals(
        await stackRows(legacy),
        compile.compileConnectionStack(nameBase(legacy), "attio", saved),
      ),
    ).toBe(true);
  });
});
