import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

/**
 * Who a new credential is on for, on REAL PostgreSQL: nobody by default, and
 * the one agent a connect started from (`agent-connect-grant-service`).
 *
 * Read back through the real grants surface (`getAgentGrants`), i.e. exactly
 * what the attach toggles and the gateway's injection selection read.
 *
 * Laws, each with a planted negative control:
 *  - the connecting agent gets the default attach, and only it: a sibling and
 *    an agent of ANOTHER workspace are never touched;
 *  - a foreign or unknown connecting agent is refused (404) before anything is
 *    stored, and the best-effort grant never throws;
 *  - ADD-ONLY: an existing (customized) grant is never flattened back;
 *  - one publish when it writes, none when there is nothing to write;
 *  - a new CUSTOM secret and a new agent get nothing automatically (an LLM
 *    key still reaches the agents holding none);
 *  - the custom secret's "choose agents" view lists every agent with its
 *    state, org-granted ones locked on.
 *
 * And the agent-delete half: a deleted agent's rules never outlive it as
 * identity-less ("every agent") rules, in the draft or any generation.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type ConnectGrant = typeof import("./agent-connect-grant-service");
type Grants = typeof import("./grants-service");
type Secrets = typeof import("./secret-service");

let db: Db;
let connectGrant: ConnectGrant;
let grants: Grants;
let secretService: Secrets;

const P = "acg-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OTHER_WORKSPACE = `${P}other-ws`;
const AGENT_1 = `${P}agent-1`;
const AGENT_2 = `${P}agent-2`;
const FOREIGN_AGENT = `${P}foreign-agent`;
const CONNECTION = `${P}conn`;

const SCOPE = { workspaceId: WORKSPACE, organizationId: ORG };

const clean = async () => {
  await db.policyRuleV2.deleteMany({
    where: {
      OR: [
        { workspaceId: { startsWith: P } },
        { organizationId: { startsWith: P } },
      ],
    },
  });
  await db.appConnection.deleteMany({
    where: {
      OR: [{ id: { startsWith: P } }, { workspaceId: { startsWith: P } }],
    },
  });
  await db.secret.deleteMany({
    where: {
      OR: [
        { id: { startsWith: P } },
        { workspaceId: { startsWith: P } },
        { organizationId: { startsWith: P } },
      ],
    },
  });
  await db.agent.deleteMany({ where: { workspaceId: { startsWith: P } } });
};

const makeAgent = (id: string, workspaceId = WORKSPACE) =>
  db.agent.create({
    data: {
      id,
      workspaceId,
      name: id,
      identifier: id,
      accessToken: `aoc_${id}_token`,
    },
  });

const makeConnection = () =>
  db.appConnection.create({
    data: {
      id: CONNECTION,
      scope: "workspace",
      workspaceId: WORKSPACE,
      provider: "google-calendar",
      status: "connected",
      label: "calendar@example.com",
    },
  });

const connectionsOf = async (agentId: string, workspaceId = WORKSPACE) =>
  (
    await grants.getAgentGrants({ workspaceId, organizationId: ORG }, agentId)
  ).connections.map((c) => `${c.connectionId}:${c.access}`);

const secretsOf = async (agentId: string, workspaceId = WORKSPACE) =>
  (
    await grants.getAgentGrants({ workspaceId, organizationId: ORG }, agentId)
  ).secrets.map((s) => s.secretId);

const latestGeneration = async () =>
  (
    await db.policyRuleV2.aggregate({
      where: { workspaceId: WORKSPACE, status: "published" },
      _max: { generation: true },
    })
  )._max.generation ?? 0;

/** Rules that would apply to EVERY agent because they lost their identity:
 * the hazard the delete path exists to prevent. The Default Rule is
 * identity-less by design and excluded. */
const everyoneRules = (where: { status?: string; generation?: number } = {}) =>
  db.policyRuleV2.count({
    where: {
      workspaceId: WORKSPACE,
      isDefault: false,
      identities: { none: {} },
      ...where,
    },
  });

const makeSecret = (id: string, type: string, hostPattern: string) =>
  db.secret.create({
    data: {
      id,
      scope: "workspace",
      workspaceId: WORKSPACE,
      name: id,
      type,
      encryptedValue: "enc:v",
      hostPattern,
    },
  });

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  connectGrant = await import("./agent-connect-grant-service");
  grants = await import("./grants-service");
  secretService = await import("./secret-service");
  const providers = await import("../providers");
  providers.initCrypto({
    encrypt: async (v: string) => `enc:${v}`,
    decrypt: async (v: string) => v.replace(/^enc:/, ""),
  });
  await clean();
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  for (const id of [WORKSPACE, OTHER_WORKSPACE]) {
    await db.workspace.create({ data: { id, name: id, organizationId: ORG } });
  }
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await clean();
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
  await db.$disconnect();
});

beforeEach(async () => {
  const providers = await import("../providers");
  providers.initRuleActionGate({ assertAllowed: async () => {} });
  providers.initPolicyValidator({ validate: async () => {} });
  if (!PROOF_URL) return;
  await clean();
});

describe.skipIf(!PROOF_URL)(
  "who a new credential is on for, over real PostgreSQL",
  () => {
    it("the connecting agent gets the default attach, and nobody else does", async () => {
      await makeAgent(AGENT_1);
      await makeAgent(AGENT_2);
      await makeAgent(FOREIGN_AGENT, OTHER_WORKSPACE);
      await makeConnection();

      await connectGrant.grantConnectingAgent(
        WORKSPACE,
        CONNECTION,
        AGENT_1,
        null,
      );

      // The product default (reads allowed, writes need approval) is a
      // customized stack, which the grants view reads back as "custom".
      expect(await connectionsOf(AGENT_1)).toEqual([`${CONNECTION}:custom`]);
      expect(await connectionsOf(AGENT_2)).toEqual([]);
      expect(await connectionsOf(FOREIGN_AGENT, OTHER_WORKSPACE)).toEqual([]);
    });

    it("no connecting agent (a workspace connect) grants nothing and publishes nothing", async () => {
      await makeAgent(AGENT_1);
      await makeConnection();
      const before = await latestGeneration();

      await connectGrant.grantConnectingAgent(
        WORKSPACE,
        CONNECTION,
        undefined,
        null,
      );

      expect(await connectionsOf(AGENT_1)).toEqual([]);
      expect(await latestGeneration()).toBe(before);
    });

    it("a foreign or unknown connecting agent is refused before anything is stored", async () => {
      await makeAgent(FOREIGN_AGENT, OTHER_WORKSPACE);

      await expect(
        connectGrant.assertConnectingAgent(WORKSPACE, FOREIGN_AGENT),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        connectGrant.assertConnectingAgent(WORKSPACE, `${P}no-such-agent`),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await makeAgent(AGENT_1);
      await expect(
        connectGrant.assertConnectingAgent(WORKSPACE, AGENT_1),
      ).resolves.toBeUndefined();
    });

    it("the grant itself is fenced and best-effort: a foreign agent or connection grants nothing, never throws", async () => {
      await makeAgent(AGENT_1);
      await makeAgent(FOREIGN_AGENT, OTHER_WORKSPACE);
      await makeConnection();
      await db.appConnection.create({
        data: {
          id: `${P}conn-foreign`,
          scope: "workspace",
          workspaceId: OTHER_WORKSPACE,
          provider: "github",
          status: "connected",
        },
      });

      await expect(
        connectGrant.grantConnectingAgent(
          WORKSPACE,
          CONNECTION,
          FOREIGN_AGENT,
          null,
        ),
      ).resolves.toBeUndefined();
      await expect(
        connectGrant.grantConnectingAgent(
          WORKSPACE,
          `${P}conn-foreign`,
          AGENT_1,
          null,
        ),
      ).resolves.toBeUndefined();

      expect(await connectionsOf(AGENT_1)).toEqual([]);
      expect(await connectionsOf(FOREIGN_AGENT, OTHER_WORKSPACE)).toEqual([]);
    });

    it("ADD-ONLY: a customized grant is never flattened back to the default", async () => {
      await makeAgent(AGENT_1);
      await makeConnection();
      // AGENT_1 narrowed this connection by hand before connecting the same
      // account again from its own page: its choice must survive.
      await grants.setConnectionGrant(
        SCOPE,
        AGENT_1,
        CONNECTION,
        { access: "full" },
        null,
      );
      const before = await latestGeneration();

      await connectGrant.grantConnectingAgent(
        WORKSPACE,
        CONNECTION,
        AGENT_1,
        null,
      );

      expect(await connectionsOf(AGENT_1)).toEqual([`${CONNECTION}:full`]);
      expect(await latestGeneration()).toBe(before);
    });

    it("writes ONE published generation, and is idempotent", async () => {
      await makeAgent(AGENT_1);
      await makeConnection();
      const before = await latestGeneration();

      await connectGrant.grantConnectingAgent(
        WORKSPACE,
        CONNECTION,
        AGENT_1,
        null,
      );
      expect(await latestGeneration()).toBe(before + 1);
      const rules = await db.policyRuleV2.count({
        where: { workspaceId: WORKSPACE },
      });

      await connectGrant.grantConnectingAgent(
        WORKSPACE,
        CONNECTION,
        AGENT_1,
        null,
      );
      expect(await latestGeneration()).toBe(before + 1);
      expect(
        await db.policyRuleV2.count({ where: { workspaceId: WORKSPACE } }),
      ).toBe(rules);

      // The attach toggle's off is removeConnectionGrant; nothing re-grants it.
      await grants.removeConnectionGrant(SCOPE, AGENT_1, CONNECTION, null);
      expect(await connectionsOf(AGENT_1)).toEqual([]);
    });

    it("a new CUSTOM secret is on for no agent", async () => {
      await makeAgent(AGENT_1);
      await makeAgent(AGENT_2);

      const secret = await secretService.createSecret(
        { workspaceId: WORKSPACE },
        {
          name: "Custom API",
          type: "generic",
          value: "custom-secret-value",
          hostPattern: "api.example.com",
          injectionConfig: { headerName: "x-api-key" },
        },
      );

      expect(secret.attachedAgents).toEqual([]);
      expect(await secretsOf(AGENT_1)).toEqual([]);
      expect(await secretsOf(AGENT_2)).toEqual([]);
    });

    it("a NEW agent starts with no connection and no custom secret, only the LLM key it runs on", async () => {
      await makeConnection();
      await makeSecret(`${P}custom`, "generic", "api.example.com");
      const llm = await makeSecret(`${P}llm`, "anthropic", "api.anthropic.com");

      const created = await (
        await import("./agent-service")
      ).createAgent(WORKSPACE, { name: "Fresh", identifier: `${P}fresh` });

      expect(created.llmKeys).toEqual([llm.id]);
      expect(await connectionsOf(created.id)).toEqual([]);
      expect(await secretsOf(created.id)).toEqual([llm.id]);
    });

    describe("the custom secret's agent access", () => {
      it("lists every agent of the workspace with its own switch state", async () => {
        await makeAgent(AGENT_1);
        await makeAgent(AGENT_2);
        await makeAgent(FOREIGN_AGENT, OTHER_WORKSPACE);
        const secret = await makeSecret(
          `${P}custom`,
          "generic",
          "api.example.com",
        );
        await grants.setSecretGrant(SCOPE, AGENT_2, secret.id, null);

        const access = await grants.getSecretAgentAccess(SCOPE, secret.id);

        expect(access.agents).toEqual([
          {
            agentId: AGENT_1,
            name: AGENT_1,
            granted: false,
            orgGranted: false,
          },
          {
            agentId: AGENT_2,
            name: AGENT_2,
            granted: true,
            orgGranted: false,
          },
        ]);
      });

      it("an agent an ORG rule grants it to reads locked on", async () => {
        await makeAgent(AGENT_1);
        const secret = await makeSecret(
          `${P}custom`,
          "generic",
          "api.example.com",
        );
        await db.policyRuleV2.create({
          data: {
            scope: "organization",
            organizationId: ORG,
            status: "published",
            generation: 1,
            priority: 1,
            source: "custom",
            logicalId: `${P}org-secret-rule`,
            name: "org grants the custom secret",
            action: "allow",
            identities: { create: [{ agentId: AGENT_1 }] },
            targets: { create: [{ kind: "secret", secretId: secret.id }] },
          },
        });

        const access = await grants.getSecretAgentAccess(SCOPE, secret.id);

        expect(access.agents).toEqual([
          {
            agentId: AGENT_1,
            name: AGENT_1,
            granted: false,
            orgGranted: true,
          },
        ]);
      });

      it("a secret of another workspace is a 404, never a listing", async () => {
        await db.secret.create({
          data: {
            id: `${P}foreign-secret`,
            scope: "workspace",
            workspaceId: OTHER_WORKSPACE,
            name: "foreign",
            type: "generic",
            encryptedValue: "enc:v",
            hostPattern: "api.example.com",
          },
        });

        await expect(
          grants.getSecretAgentAccess(SCOPE, `${P}foreign-secret`),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      });
    });

    describe("agent delete", () => {
      const deleteAgent = async (agentId: string) =>
        (await import("./agent-service")).deleteAgent(WORKSPACE, agentId);

      /** A hand-written workspace rule naming `agentIds`, in the draft and
       * in the live generation: the shape the rules editor produces. */
      const handRule = async (name: string, agentIds: string[]) => {
        const generation = await latestGeneration();
        for (const status of ["draft", "published"] as const) {
          await db.policyRuleV2.create({
            data: {
              scope: "workspace",
              workspaceId: WORKSPACE,
              status,
              generation: status === "draft" ? 0 : generation,
              priority: 5,
              source: "custom",
              logicalId: `${P}${name}`,
              name,
              action: "allow",
              identities: { create: agentIds.map((agentId) => ({ agentId })) },
              targets: {
                create: [{ kind: "network", hostPattern: "api.example.com" }],
              },
            },
          });
        }
      };

      it("a deleted agent's grants never block a sibling: planted control", async () => {
        await makeAgent(AGENT_1);
        await makeAgent(AGENT_2);
        await makeConnection();
        // AGENT_1 gets a CUSTOM stack (allowed / everything else: block), the
        // shape that, orphaned, used to block every agent.
        await grants.setConnectionGrant(
          SCOPE,
          AGENT_1,
          CONNECTION,
          { access: "custom", allow: ["list_events"], ask: [] },
          null,
        );
        await grants.setConnectionGrant(
          SCOPE,
          AGENT_2,
          CONNECTION,
          { access: "full" },
          null,
        );

        await deleteAgent(AGENT_1);

        expect(await everyoneRules()).toBe(0);
        // The sibling's grant survives untouched.
        expect(await connectionsOf(AGENT_2)).toEqual([`${CONNECTION}:full`]);
      });

      it("a HAND-WRITTEN rule naming only the agent goes too; one naming others just loses it", async () => {
        // An "allow" scoped to one agent must not widen to every agent when
        // that agent goes; a rule shared with a sibling keeps the sibling.
        await makeAgent(AGENT_1);
        await makeAgent(AGENT_2);
        await handRule("solo", [AGENT_1]);
        await handRule("shared", [AGENT_1, AGENT_2]);

        await deleteAgent(AGENT_1);

        expect(await everyoneRules()).toBe(0);
        const left = await db.policyRuleV2.findMany({
          where: { workspaceId: WORKSPACE, isDefault: false },
          select: { name: true, identities: { select: { agentId: true } } },
        });
        // Draft + live copy of the shared rule, each down to the sibling.
        expect(left).toHaveLength(2);
        for (const row of left) {
          expect(row.name).toBe("shared");
          expect(row.identities).toEqual([{ agentId: AGENT_2 }]);
        }
      });

      it("also sweeps GRANT rules orphaned by an earlier delete, never an authored one", async () => {
        // The migration runs before the rollout, so the previous release can
        // still orphan a grant in that window; the next delete cleans it up.
        // An identity-less HAND-WRITTEN rule is "applies to everyone" on
        // purpose and must survive.
        await makeAgent(AGENT_1);
        await makeAgent(AGENT_2);
        await makeConnection();
        await grants.setConnectionGrant(
          SCOPE,
          AGENT_1,
          CONNECTION,
          { access: "full" },
          null,
        );
        await handRule("everyone", []);
        // The old bug: the agent row went, its identities cascaded off.
        await db.agent.delete({ where: { id: AGENT_1 } });
        expect(
          await db.policyRuleV2.count({
            where: {
              workspaceId: WORKSPACE,
              source: "grant",
              identities: { none: {} },
            },
          }),
        ).toBeGreaterThan(0);

        await deleteAgent(AGENT_2);

        expect(
          await db.policyRuleV2.count({
            where: {
              workspaceId: WORKSPACE,
              source: "grant",
              identities: { none: {} },
            },
          }),
        ).toBe(0);
        // Draft + live copy of the authored rule, untouched.
        expect(
          await db.policyRuleV2.count({
            where: { workspaceId: WORKSPACE, name: "everyone" },
          }),
        ).toBe(2);
      });

      it("cleans EVERY retained generation, so a rollback can't resurrect the rule", async () => {
        await makeAgent(AGENT_1);
        await makeConnection();
        await grants.setConnectionGrant(
          SCOPE,
          AGENT_1,
          CONNECTION,
          { access: "full" },
          null,
        );
        // A second publish leaves the first generation behind as a rollback
        // target that still names the agent.
        await makeSecret(`${P}custom`, "generic", "api.example.com");
        await grants.setSecretGrant(SCOPE, AGENT_1, `${P}custom`, null);
        const generations = await db.policyRuleV2.groupBy({
          by: ["generation"],
          where: { workspaceId: WORKSPACE, status: "published" },
        });
        expect(generations.length).toBeGreaterThan(1);

        await deleteAgent(AGENT_1);

        expect(await everyoneRules({ status: "published" })).toBe(0);
        expect(await everyoneRules({ status: "draft" })).toBe(0);
      });

      it("publishes nothing: a staged draft edit stays staged", async () => {
        // A republish here would ship whatever the workspace has staged, past
        // the plan gates `publishPolicy` re-asserts. The delete edits the
        // live generation in place instead.
        await makeAgent(AGENT_1);
        await makeAgent(AGENT_2);
        await makeConnection();
        await grants.setConnectionGrant(
          SCOPE,
          AGENT_1,
          CONNECTION,
          { access: "full" },
          null,
        );
        const generation = await latestGeneration();
        // Staged, unpublished: a draft-only rule.
        await db.policyRuleV2.create({
          data: {
            scope: "workspace",
            workspaceId: WORKSPACE,
            status: "draft",
            priority: 6,
            source: "custom",
            logicalId: `${P}staged`,
            name: "staged",
            action: "block",
            identities: { create: [{ agentId: AGENT_2 }] },
            targets: {
              create: [{ kind: "network", hostPattern: "staged.example.com" }],
            },
          },
        });

        await deleteAgent(AGENT_1);

        expect(await latestGeneration()).toBe(generation);
        expect(
          await db.policyRuleV2.count({
            where: {
              workspaceId: WORKSPACE,
              status: "published",
              name: "staged",
            },
          }),
        ).toBe(0);
      });

      it("never deadlocks against a concurrent grant write", async () => {
        // Grant writes take the scope lock, then touch the agent row (its
        // identity FK); the delete takes them in the same order. The opposite
        // order deadlocked (Postgres aborted one side).
        await makeAgent(AGENT_1);
        await makeAgent(AGENT_2);
        await makeConnection();

        for (let round = 0; round < 5; round++) {
          const victim = `${P}victim-${round}`;
          await makeAgent(victim);
          const results = await Promise.allSettled([
            grants.setConnectionGrant(
              SCOPE,
              victim,
              CONNECTION,
              { access: "full" },
              null,
            ),
            deleteAgent(victim),
            grants.setConnectionGrant(
              SCOPE,
              AGENT_2,
              CONNECTION,
              { access: round % 2 ? "full" : "custom", allow: [], ask: [] },
              null,
            ),
          ]);
          const errors = results
            .filter((r) => r.status === "rejected")
            .map((r) => String((r as PromiseRejectedResult).reason));
          // The victim's grant may lose the race (NOT_FOUND once it's gone);
          // a deadlock is the one failure that must never appear.
          expect(errors.join("\n")).not.toMatch(/deadlock/i);
          expect(results[1]?.status).toBe("fulfilled");
        }
        expect(await everyoneRules()).toBe(0);
      });
    });

    describe("migration 20260929110000_drop_orphaned_agent_grants", () => {
      const MIGRATION = join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../db/prisma/migrations/20260929110000_drop_orphaned_agent_grants/migration.sql",
      );

      it("deletes identity-less GRANT rules only, and is idempotent", async () => {
        // `prisma migrate deploy` already ran it on this database, so the
        // pre-migration world is seeded here and the file re-applied verbatim.
        await makeAgent(AGENT_1);
        const orphanGrant = await db.policyRuleV2.create({
          data: {
            scope: "workspace",
            workspaceId: WORKSPACE,
            status: "published",
            generation: 1,
            priority: 1,
            source: "grant",
            name: "orphaned grant",
            action: "block",
            targets: {
              create: [{ kind: "network", hostPattern: "api.example.com" }],
            },
          },
        });
        const liveGrant = await db.policyRuleV2.create({
          data: {
            scope: "workspace",
            workspaceId: WORKSPACE,
            status: "draft",
            priority: 2,
            source: "grant",
            name: "live grant",
            action: "allow",
            identities: { create: [{ agentId: AGENT_1 }] },
          },
        });
        // "Applies to everyone" is a legitimate AUTHORED rule.
        const everyone = await db.policyRuleV2.create({
          data: {
            scope: "workspace",
            workspaceId: WORKSPACE,
            status: "draft",
            priority: 3,
            source: "custom",
            name: "everyone",
            action: "allow",
          },
        });

        const sql = readFileSync(MIGRATION, "utf8");
        await db.$executeRawUnsafe(sql);
        await db.$executeRawUnsafe(sql);

        const left = await db.policyRuleV2.findMany({
          where: { workspaceId: WORKSPACE },
          select: { id: true },
        });
        const ids = left.map((r) => r.id);
        expect(ids).not.toContain(orphanGrant.id);
        expect(ids).toContain(liveGrant.id);
        expect(ids).toContain(everyone.id);
        // Its targets went with it (cascade), not left dangling.
        expect(
          await db.policyRuleTarget.count({
            where: { ruleId: orphanGrant.id },
          }),
        ).toBe(0);
      });
    });
  },
);
