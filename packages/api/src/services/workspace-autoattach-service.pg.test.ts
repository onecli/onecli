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
 * The workspace auto-attach on REAL PostgreSQL: a connection or secret
 * CREATED in a workspace is on for every agent of that workspace, and a new
 * agent starts with everything the workspace already has.
 *
 * Read back through the real grants surface (`getAgentGrants`), i.e. exactly
 * what the dialog toggles and the gateway's injection selection read.
 *
 * Laws, each with a planted negative control:
 *  - every agent of the workspace gets a new connection, as a whole-app grant;
 *  - every agent gets a new CUSTOM secret; a new LLM key goes only to the
 *    agents holding none, so a deliberately configured agent is not re-pointed;
 *  - an agent in ANOTHER workspace is never touched;
 *  - an ORG-scoped secret attaches to nothing;
 *  - ADD-ONLY: an existing (customized) grant is never flattened back to full;
 *  - however many pairs, ONE transaction and ONE published generation;
 *  - it is idempotent, and a detach afterwards sticks.
 *
 * And the agent-delete half: a deleted agent's rules never outlive it as
 * identity-less ("every agent") rules, in the draft or any generation.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type AutoAttach = typeof import("./workspace-autoattach-service");
type Grants = typeof import("./grants-service");
type Secrets = typeof import("./secret-service");

let db: Db;
let autoAttach: AutoAttach;
let grants: Grants;
let secretService: Secrets;

const P = "waa-";
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

/** The agents a result wrote to, sorted: the shape the laws compare. */
const agentsIn = (pairs: { agentId: string }[]) =>
  [...new Set(pairs.map((p) => p.agentId))].sort();

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
  autoAttach = await import("./workspace-autoattach-service");
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
  "workspace auto-attach over real PostgreSQL",
  () => {
    it("a new connection is on for every agent of the workspace, as full access", async () => {
      await makeAgent(AGENT_1);
      await makeAgent(AGENT_2);
      await makeConnection();

      const written = await autoAttach.attachNewConnectionToAllAgents(
        WORKSPACE,
        CONNECTION,
        null,
      );

      expect(agentsIn(written.connections)).toEqual([AGENT_1, AGENT_2].sort());
      expect(await connectionsOf(AGENT_1)).toEqual([`${CONNECTION}:full`]);
      expect(await connectionsOf(AGENT_2)).toEqual([`${CONNECTION}:full`]);
    });

    it("an agent in another workspace is never touched — planted control", async () => {
      await makeAgent(AGENT_1);
      await makeAgent(FOREIGN_AGENT, OTHER_WORKSPACE);
      await makeConnection();

      const written = await autoAttach.attachNewConnectionToAllAgents(
        WORKSPACE,
        CONNECTION,
        null,
      );

      expect(agentsIn(written.connections)).toEqual([AGENT_1]);
      expect(await connectionsOf(FOREIGN_AGENT, OTHER_WORKSPACE)).toEqual([]);
    });

    it("is idempotent, and a detach afterwards sticks", async () => {
      await makeAgent(AGENT_1);
      await makeConnection();
      await autoAttach.attachNewConnectionToAllAgents(
        WORKSPACE,
        CONNECTION,
        null,
      );
      const before = await db.policyRuleV2.count({
        where: { workspaceId: WORKSPACE },
      });

      await autoAttach.attachNewConnectionToAllAgents(
        WORKSPACE,
        CONNECTION,
        null,
      );
      expect(
        await db.policyRuleV2.count({ where: { workspaceId: WORKSPACE } }),
      ).toBe(before);

      // The dialog's toggle-off is removeConnectionGrant; nothing re-grants it.
      await grants.removeConnectionGrant(SCOPE, AGENT_1, CONNECTION, null);
      expect(await connectionsOf(AGENT_1)).toEqual([]);
    });

    it("createSecret puts a CUSTOM secret on for every agent", async () => {
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

      expect(secret.attachedAgents.sort()).toEqual([AGENT_1, AGENT_2].sort());
      expect(await secretsOf(AGENT_1)).toEqual([secret.id]);
      expect(await secretsOf(AGENT_2)).toEqual([secret.id]);
    });

    it("an ORG-scoped secret attaches to nothing — planted control", async () => {
      await makeAgent(AGENT_1);

      const secret = await secretService.createSecret(
        { organizationId: ORG },
        {
          name: "Org Custom API",
          type: "generic",
          value: "org-value",
          hostPattern: "api.example.com",
          injectionConfig: { headerName: "x-api-key" },
        },
      );

      expect(secret.attachedAgents).toEqual([]);
      expect(await secretsOf(AGENT_1)).toEqual([]);
    });

    it("a workspace with no agents attaches nothing and does not throw", async () => {
      await makeConnection();
      const written = await autoAttach.attachNewConnectionToAllAgents(
        WORKSPACE,
        CONNECTION,
        null,
      );
      expect(written).toEqual({ connections: [], secrets: [] });
    });

    it("a NEW agent starts with every live workspace connection and custom secret", async () => {
      await makeConnection();
      const custom = await makeSecret(
        `${P}custom`,
        "generic",
        "api.example.com",
      );
      await makeAgent(AGENT_1);

      const written = await autoAttach.attachWorkspaceResourcesToNewAgent(
        WORKSPACE,
        AGENT_1,
        null,
      );

      expect(written).toEqual({
        connections: [{ agentId: AGENT_1, connectionId: CONNECTION }],
        secrets: [{ agentId: AGENT_1, secretId: custom.id }],
      });
      expect(await connectionsOf(AGENT_1)).toEqual([`${CONNECTION}:full`]);
      expect(await secretsOf(AGENT_1)).toEqual([custom.id]);
    });

    it("a NEW agent never gets disconnected, org-level, LLM, or foreign resources — planted controls", async () => {
      await db.appConnection.create({
        data: {
          id: `${P}conn-disconnected`,
          scope: "workspace",
          workspaceId: WORKSPACE,
          provider: "github",
          status: "disconnected",
        },
      });
      await db.appConnection.create({
        data: {
          id: `${P}conn-foreign`,
          scope: "workspace",
          workspaceId: OTHER_WORKSPACE,
          provider: "github",
          status: "connected",
        },
      });
      await db.secret.create({
        data: {
          id: `${P}org-secret`,
          scope: "organization",
          organizationId: ORG,
          name: "Org API",
          type: "generic",
          encryptedValue: "enc:v",
          hostPattern: "api.example.com",
        },
      });
      await makeSecret(`${P}llm`, "anthropic", "api.anthropic.com");
      await makeAgent(AGENT_1);

      const written = await autoAttach.attachWorkspaceResourcesToNewAgent(
        WORKSPACE,
        AGENT_1,
        null,
      );

      expect(written).toEqual({ connections: [], secrets: [] });
      expect(await connectionsOf(AGENT_1)).toEqual([]);
      expect(await secretsOf(AGENT_1)).toEqual([]);
    });

    it("ADD-ONLY: a customized grant is never flattened back to full access", async () => {
      await makeAgent(AGENT_1);
      await makeAgent(AGENT_2);
      await makeConnection();
      // AGENT_1 narrowed this connection by hand before the attach ran again
      // (a reconnect, a retried callback): its choice must survive.
      await grants.setConnectionGrant(
        SCOPE,
        AGENT_1,
        CONNECTION,
        { access: "custom", allow: ["list_events"], ask: [] },
        null,
      );

      const written = await autoAttach.attachNewConnectionToAllAgents(
        WORKSPACE,
        CONNECTION,
        null,
      );

      // Only the agent with no stack was written.
      expect(agentsIn(written.connections)).toEqual([AGENT_2]);
      expect(await connectionsOf(AGENT_1)).toEqual([`${CONNECTION}:custom`]);
      expect(await connectionsOf(AGENT_2)).toEqual([`${CONNECTION}:full`]);
    });

    it("ONE published generation however many (agent, resource) pairs", async () => {
      // The per-pair writers publish once per pair: a new agent in a
      // workspace with N resources burned N generations, pushing every
      // rollback target out of the retention window.
      await makeAgent(AGENT_1);
      await makeConnection();
      for (const n of [1, 2, 3]) {
        await makeSecret(`${P}custom-${n}`, "generic", `api${n}.example.com`);
      }
      const before = await latestGeneration();

      const written = await autoAttach.attachWorkspaceResourcesToNewAgent(
        WORKSPACE,
        AGENT_1,
        null,
      );

      expect(written.connections).toHaveLength(1);
      expect(written.secrets).toHaveLength(3);
      expect(await latestGeneration()).toBe(before + 1);

      // Nothing new to write → no publish at all.
      await autoAttach.attachWorkspaceResourcesToNewAgent(
        WORKSPACE,
        AGENT_1,
        null,
      );
      expect(await latestGeneration()).toBe(before + 1);
    });

    it("the writer itself refuses an LLM key, even when named explicitly", async () => {
      // An LLM grant changes a hosted agent's spawn payload, so it needs the
      // per-pair writer's respawn; the bulk writer must not grant one silently.
      await makeAgent(AGENT_1);
      const llm = await makeSecret(`${P}llm`, "anthropic", "api.anthropic.com");

      const written = await grants.addDefaultGrants(
        SCOPE,
        { agentIds: [AGENT_1], connectionIds: [], secretIds: [llm.id] },
        null,
      );

      expect(written).toEqual({ connections: [], secrets: [] });
      expect(await secretsOf(AGENT_1)).toEqual([]);
    });

    it("the writer is fenced: a foreign agent or resource is skipped, never granted", async () => {
      await makeAgent(AGENT_1);
      await makeAgent(FOREIGN_AGENT, OTHER_WORKSPACE);
      await db.appConnection.create({
        data: {
          id: `${P}conn-foreign`,
          scope: "workspace",
          workspaceId: OTHER_WORKSPACE,
          provider: "github",
          status: "connected",
        },
      });

      const written = await grants.addDefaultGrants(
        SCOPE,
        {
          agentIds: [AGENT_1, FOREIGN_AGENT],
          connectionIds: [`${P}conn-foreign`],
          secretIds: [],
        },
        null,
      );

      expect(written).toEqual({ connections: [], secrets: [] });
      expect(await connectionsOf(AGENT_1)).toEqual([]);
    });

    it("a new LLM key never re-points an agent that already runs on another provider", async () => {
      // The OpenAI agent was set up on purpose; granting it a second key would
      // switch its provider, drop its chosen model and respawn its sandbox.
      // The keyless agent is the only one that needs the new key.
      await makeAgent(AGENT_1);
      await makeAgent(AGENT_2);
      const openai = await makeSecret(`${P}openai`, "openai", "api.openai.com");
      await grants.setSecretGrant(SCOPE, AGENT_1, openai.id, null);

      const anthropic = await secretService.createSecret(
        { workspaceId: WORKSPACE },
        {
          name: "Anthropic API Key",
          type: "anthropic",
          value: "sk-ant-new",
          hostPattern: "api.anthropic.com",
        },
      );

      expect(anthropic.attachedAgents).toEqual([AGENT_2]);
      expect(await secretsOf(AGENT_1)).toEqual([openai.id]);
      expect(await secretsOf(AGENT_2)).toEqual([anthropic.id]);
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
