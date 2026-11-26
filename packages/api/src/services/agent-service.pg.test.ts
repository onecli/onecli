import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";
import { LAST_SEEN_WINDOW_MS } from "../lib/agent-activity.js";

// Pinned onprem: the foundation suites below create BOTH kinds against one
// unstamped org, which the cloud creation-world gate (§3.10 re-decided
// 2026-08-23) would refuse under the CI job's ambient cloud edition. The gate
// reads the edition per call, so its own describe pins cloud per test against
// dedicated world orgs.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

/**
 * `getAgentDetail` on REAL PostgreSQL — the Install page's verify signal.
 * Laws: `recentRequestAt` reflects only requests inside the lookback window
 * (an older request reads as null, so the query stays bounded on the
 * (workspace_id, created_at) index), and the read is workspace-fenced — another
 * workspace's agent id is NOT_FOUND, never a cross-workspace disclosure (the
 * planted negative control).
 *
 * Env-gated like the other proof suites; see pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Agents = typeof import("./agent-service");

let db: Db;
let agents: Agents;

const P = "agd-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const OTHER_WORKSPACE = `${P}other-proj`;
// The creation-world orgs (cloud gate suite): one per world.
const HOSTED_WORLD_ORG = `${P}org-hosted-world`;
const HOSTED_WORLD_WS = `${P}proj-hosted-world`;
const BYO_WORLD_ORG = `${P}org-byo-world`;
const BYO_WORLD_WS = `${P}proj-byo-world`;
const MIXED_WORLD_ORG = `${P}org-mixed-world`;
const MIXED_WORLD_WS = `${P}proj-mixed-world`;
const AGENT_ACTIVE = `${P}agent-active`;
const AGENT_IDLE = `${P}agent-idle`;
const AGENT_DORMANT = `${P}agent-dormant`;
const AGENT_FRESH = `${P}agent-fresh`;
const AGENT_FOREIGN = `${P}agent-foreign`;

const reset = async () => {
  await db.requestLog.deleteMany({ where: { workspaceId: { startsWith: P } } });
  await db.sandbox.deleteMany({ where: { id: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
  // By id AND identifier: service-created rows carry uuid ids but P-prefixed
  // identifiers, and a mid-test failure must not leak them past reset.
  await db.agent.deleteMany({
    where: {
      OR: [{ id: { startsWith: P } }, { identifier: { startsWith: P } }],
    },
  });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

const requestLogRow = (agentId: string, createdAt: Date) => ({
  workspaceId: WORKSPACE,
  agentId,
  method: "GET",
  host: "api.example.com",
  path: "/v1/ping",
  provider: "custom",
  status: 200,
  latencyMs: 12,
  injectionCount: 1,
  createdAt,
});

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  agents = await import("./agent-service");
  await reset();

  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: WORKSPACE, organizationId: ORG },
  });
  await db.workspace.create({
    data: { id: OTHER_WORKSPACE, name: OTHER_WORKSPACE, organizationId: ORG },
  });
  // The two creation worlds (§3.10 re-decided): byoLegacy false = hosted-only,
  // true = BYO-only. Dedicated orgs so the gate suite can't disturb the
  // foundation fixtures above.
  await db.organization.create({
    data: {
      id: HOSTED_WORLD_ORG,
      name: HOSTED_WORLD_ORG,
      slug: HOSTED_WORLD_ORG,
    },
  });
  await db.workspace.create({
    data: {
      id: HOSTED_WORLD_WS,
      name: HOSTED_WORLD_WS,
      organizationId: HOSTED_WORLD_ORG,
    },
  });
  await db.organization.create({
    data: {
      id: BYO_WORLD_ORG,
      name: BYO_WORLD_ORG,
      slug: BYO_WORLD_ORG,
      byoLegacy: true,
    },
  });
  await db.workspace.create({
    data: {
      id: BYO_WORLD_WS,
      name: BYO_WORLD_WS,
      organizationId: BYO_WORLD_ORG,
    },
  });
  // The mixed world (2026-08-29): byoLegacy false + byoEnabled true — hosted
  // stays the default, BYO creation is additionally allowed.
  await db.organization.create({
    data: {
      id: MIXED_WORLD_ORG,
      name: MIXED_WORLD_ORG,
      slug: MIXED_WORLD_ORG,
      byoEnabled: true,
    },
  });
  await db.workspace.create({
    data: {
      id: MIXED_WORLD_WS,
      name: MIXED_WORLD_WS,
      organizationId: MIXED_WORLD_ORG,
    },
  });

  const agent = (id: string, workspaceId: string) =>
    db.agent.create({
      data: {
        id,
        workspaceId,
        name: id,
        identifier: id,
        accessToken: `aoc_${id}`,
      },
    });
  await agent(AGENT_ACTIVE, WORKSPACE);
  await agent(AGENT_IDLE, WORKSPACE);
  await agent(AGENT_DORMANT, WORKSPACE);
  await agent(AGENT_FRESH, WORKSPACE);
  await agent(AGENT_FOREIGN, OTHER_WORKSPACE);
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
});

describe.skipIf(!PROOF_URL)("getAgentDetail over real PostgreSQL", () => {
  it("returns the newest in-window request as recentRequestAt", async () => {
    const older = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const newest = new Date(Date.now() - 60 * 1000);
    await db.requestLog.create({ data: requestLogRow(AGENT_ACTIVE, older) });
    await db.requestLog.create({ data: requestLogRow(AGENT_ACTIVE, newest) });

    const detail = await agents.getAgentDetail(WORKSPACE, AGENT_ACTIVE);
    expect(detail.identifier).toBe(AGENT_ACTIVE);
    expect(detail.recentRequestAt?.getTime()).toBe(newest.getTime());
  });

  it("reads a request older than the window as null (bounded lookback)", async () => {
    const beyondWindow = new Date(
      Date.now() - agents.RECENT_REQUEST_WINDOW_MS - 60 * 60 * 1000,
    );
    await db.requestLog.create({
      data: requestLogRow(AGENT_IDLE, beyondWindow),
    });

    const detail = await agents.getAgentDetail(WORKSPACE, AGENT_IDLE);
    expect(detail.recentRequestAt).toBeNull();
  });

  it("reads an agent with no requests at all as null", async () => {
    const detail = await agents.getAgentDetail(WORKSPACE, AGENT_FRESH);
    expect(detail.recentRequestAt).toBeNull();
  });

  it("does not attribute another agent's requests", async () => {
    // AGENT_ACTIVE has rows from the first test; AGENT_FRESH must stay null.
    const detail = await agents.getAgentDetail(WORKSPACE, AGENT_FRESH);
    expect(detail.recentRequestAt).toBeNull();
  });

  it("NOT_FOUNDs another workspace's agent id (cross-workspace control)", async () => {
    await expect(
      agents.getAgentDetail(WORKSPACE, AGENT_FOREIGN),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("NOT_FOUNDs an unknown agent id", async () => {
    await expect(
      agents.getAgentDetail(WORKSPACE, `${P}nope`),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe.skipIf(!PROOF_URL)(
  "hosted-agent foundation columns over real PostgreSQL (v2 step 1)",
  () => {
    it("defaults a plain agent row to kind byo with null hosted fields (BYO regression)", async () => {
      // The beforeAll fixtures above set none of the new columns — exactly the
      // shape every pre-step-1 insert in the codebase produces.
      const row = await db.agent.findUniqueOrThrow({
        where: { id: AGENT_FRESH },
        select: { kind: true, harness: true, model: true, instructions: true },
      });
      expect(row).toEqual({
        kind: "byo",
        harness: null,
        model: null,
        instructions: null,
      });
    });

    it("round-trips a hosted agent through the service, placing its sandbox", async () => {
      // Step 3: a hosted agent needs a runner to host it, so one must be
      // online for creation to succeed.
      await db.runner.create({
        data: {
          id: `${P}placing-runner`,
          name: "placing runner",
          token: `rnr_${P}placing`,
          capabilities: {
            maxSandboxes: 4,
            backend: "docker",
            homeDurability: "resident",
          },
          lastSeenAt: new Date(),
        },
      });

      const created = await agents.createAgent(WORKSPACE, {
        name: "Hosted One",
        identifier: `${P}hosted-one`,
        kind: "hosted",
        instructions: "Triage the support inbox.",
      });
      expect(created).toMatchObject({
        kind: "hosted",
        harness: "jcode",
        // No model: creation never asks for one (§3.10). The granted key's
        // provider supplies the default, and an override arrives via PATCH.
        model: null,
        instructions: "Triage the support inbox.",
      });

      // The computer record is born with the agent, waiting for the first poll.
      // WHICH runner it lands on is placement's business (proven in
      // due-work.pg.test.ts); what matters here is that a hosted agent always
      // gets one.
      const sandbox = await db.sandbox.findUnique({
        where: { agentId: created.id },
        select: { runnerId: true, status: true },
      });
      expect(sandbox?.status).toBe("unprovisioned");
      expect(sandbox?.runnerId).toBeTruthy();

      const detail = await agents.getAgentDetail(WORKSPACE, created.id);
      expect(detail).toMatchObject({
        kind: "hosted",
        harness: "jcode",
        instructions: "Triage the support inbox.",
      });

      await agents.updateAgent(WORKSPACE, created.id, { instructions: null });
      const cleared = await agents.getAgentDetail(WORKSPACE, created.id);
      expect(cleared.instructions).toBeNull();

      await db.agent.delete({ where: { id: created.id } });
      await db.runner.delete({ where: { id: `${P}placing-runner` } });
    });

    it("refuses a hosted agent when no runner can host it", async () => {
      // Deterministic regardless of suite order: nothing anywhere is online.
      await db.runner.updateMany({
        data: { lastSeenAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      });

      await expect(
        agents.createAgent(WORKSPACE, {
          name: "Homeless",
          identifier: `${P}homeless`,
          kind: "hosted",
        }),
      ).rejects.toMatchObject({ code: "UNPROCESSABLE" });

      // Nothing is left behind — no half-created agent without a computer.
      expect(
        await db.agent.findFirst({ where: { identifier: `${P}homeless` } }),
      ).toBeNull();
    });

    it("still creates a byo agent with no runner anywhere (BYO regression)", async () => {
      const created = await agents.createAgent(WORKSPACE, {
        name: "Plain BYO",
        identifier: `${P}plain-byo`,
      });
      expect(created.kind).toBe("byo");
      expect(
        await db.sandbox.findUnique({ where: { agentId: created.id } }),
      ).toBeNull();
      await db.agent.delete({ where: { id: created.id } });
    });

    it("defaults organizations.byo_legacy to false", async () => {
      const org = await db.organization.findUniqueOrThrow({
        where: { id: ORG },
        select: { byoLegacy: true },
      });
      expect(org.byoLegacy).toBe(false);
    });

    it("cascades the sandbox row when its agent is deleted", async () => {
      const runner = await db.runner.create({
        data: { id: `${P}runner`, name: "r", token: `rnr_${P}tok` },
      });
      const agentRow = await db.agent.create({
        data: {
          id: `${P}doomed`,
          workspaceId: WORKSPACE,
          name: "doomed",
          identifier: `${P}doomed`,
          accessToken: `aoc_${P}doomed`,
          kind: "hosted",
          harness: "jcode",
        },
      });
      await db.sandbox.create({
        data: {
          id: `${P}sandbox`,
          agentId: agentRow.id,
          runnerId: runner.id,
          homeRef: `vol-${P}doomed`,
        },
      });

      await db.agent.delete({ where: { id: agentRow.id } });

      expect(
        await db.sandbox.findUnique({ where: { id: `${P}sandbox` } }),
      ).toBeNull();
      // The runner survives — only the sandbox rides the cascade.
      expect(
        await db.runner.findUnique({ where: { id: runner.id } }),
      ).not.toBeNull();
    });
  },
);

describe.skipIf(!PROOF_URL)(
  "the creation-world gates over real PostgreSQL (cloud, §3.10 re-decided)",
  () => {
    // The gate reads the edition per call, so each case pins cloud here and
    // the hook restores the file's onprem pin — this is also the suite that
    // proves the gate's real workspace→organization join shape (the unit
    // suite's db double only mimics it).
    afterEach(() => {
      process.env.NEXT_PUBLIC_EDITION = "onprem";
    });

    it("refuses BYO creation in a hosted-world org, leaving nothing behind", async () => {
      process.env.NEXT_PUBLIC_EDITION = "cloud";
      await expect(
        agents.createAgent(HOSTED_WORLD_WS, {
          name: "Refused BYO",
          identifier: `${P}refused-byo`,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(
        await db.agent.findFirst({
          where: { identifier: `${P}refused-byo` },
        }),
      ).toBeNull();
    });

    it("refuses HOSTED creation in a BYO-world org", async () => {
      process.env.NEXT_PUBLIC_EDITION = "cloud";
      await expect(
        agents.createAgent(BYO_WORLD_WS, {
          name: "Refused Hosted",
          identifier: `${P}refused-hosted`,
          kind: "hosted",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(
        await db.agent.findFirst({
          where: { identifier: `${P}refused-hosted` },
        }),
      ).toBeNull();
    });

    it("lets a BYO-world org create BYO agents", async () => {
      process.env.NEXT_PUBLIC_EDITION = "cloud";
      const created = await agents.createAgent(BYO_WORLD_WS, {
        name: "World BYO",
        identifier: `${P}world-byo`,
      });
      expect(created.kind).toBe("byo");
      await db.agent.delete({ where: { id: created.id } });
    });

    it("lets a hosted-world org create hosted agents", async () => {
      process.env.NEXT_PUBLIC_EDITION = "cloud";
      await db.runner.create({
        data: {
          id: `${P}world-runner`,
          name: "world runner",
          token: `rnr_${P}world`,
          capabilities: {
            maxSandboxes: 4,
            backend: "docker",
            homeDurability: "resident",
          },
          lastSeenAt: new Date(),
        },
      });
      const created = await agents.createAgent(HOSTED_WORLD_WS, {
        name: "World Hosted",
        identifier: `${P}world-hosted`,
        kind: "hosted",
      });
      expect(created.kind).toBe("hosted");
      await db.agent.delete({ where: { id: created.id } });
      await db.runner.delete({ where: { id: `${P}world-runner` } });
    });

    it("lets a MIXED-world org create BOTH kinds — the gradual-migration world", async () => {
      // byoLegacy=false + byoEnabled=true (2026-08-29): the hosted default
      // stays, and BYO creation is re-opened beside it. This is also the
      // real-join proof for the gate's two-column organization select.
      process.env.NEXT_PUBLIC_EDITION = "cloud";
      const byoCreated = await agents.createAgent(MIXED_WORLD_WS, {
        name: "Mixed BYO",
        identifier: `${P}mixed-byo`,
      });
      expect(byoCreated.kind).toBe("byo");
      await db.agent.delete({ where: { id: byoCreated.id } });

      await db.runner.create({
        data: {
          id: `${P}mixed-runner`,
          name: "mixed runner",
          token: `rnr_${P}mixed`,
          capabilities: {
            maxSandboxes: 4,
            backend: "docker",
            homeDurability: "resident",
          },
          lastSeenAt: new Date(),
        },
      });
      const hostedCreated = await agents.createAgent(MIXED_WORLD_WS, {
        name: "Mixed Hosted",
        identifier: `${P}mixed-hosted`,
        kind: "hosted",
      });
      expect(hostedCreated.kind).toBe("hosted");
      await db.agent.delete({ where: { id: hostedCreated.id } });
      await db.runner.delete({ where: { id: `${P}mixed-runner` } });
    });

    it("keeps a BYO-world org's hosted refusal even with byoEnabled set — byoLegacy wins", async () => {
      process.env.NEXT_PUBLIC_EDITION = "cloud";
      await db.organization.update({
        where: { id: BYO_WORLD_ORG },
        data: { byoEnabled: true },
      });
      try {
        await expect(
          agents.createAgent(BYO_WORLD_WS, {
            name: "Still Refused Hosted",
            identifier: `${P}still-refused-hosted`,
            kind: "hosted",
          }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      } finally {
        await db.organization.update({
          where: { id: BYO_WORLD_ORG },
          data: { byoEnabled: false },
        });
      }
    });

    it("answers 409, not 403, for an existing identifier — ensureAgent stays idempotent", async () => {
      await db.agent.create({
        data: {
          id: `${P}world-taken`,
          workspaceId: HOSTED_WORLD_WS,
          name: "taken",
          identifier: `${P}world-taken`,
          accessToken: `aoc_${P}world-taken`,
        },
      });
      process.env.NEXT_PUBLIC_EDITION = "cloud";
      await expect(
        agents.createAgent(HOSTED_WORLD_WS, {
          name: "taken again",
          identifier: `${P}world-taken`,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await db.agent.delete({ where: { id: `${P}world-taken` } });
    });

    it("stays ungated on self-host — BYO creates fine in a hosted-world org", async () => {
      const created = await agents.createAgent(HOSTED_WORLD_WS, {
        name: "Onprem BYO",
        identifier: `${P}onprem-byo`,
      });
      expect(created.kind).toBe("byo");
      await db.agent.delete({ where: { id: created.id } });
    });
  },
);

describe.skipIf(!PROOF_URL)(
  "listAgents lastSeenAt over real PostgreSQL",
  () => {
    it("attributes each agent its own newest in-window request, null otherwise", async () => {
      // World state from the suite above, plus a dormant fixture: ACTIVE has
      // recent rows; IDLE's only row is beyond the 7-day detail window but
      // inside the 30-day list window (the two windows are deliberately
      // different — this pins that); DORMANT's only row is beyond the list
      // window; FRESH has none; the foreign workspace's agent must not appear.
      await db.requestLog.create({
        data: requestLogRow(
          AGENT_DORMANT,
          new Date(Date.now() - LAST_SEEN_WINDOW_MS - 60 * 60 * 1000),
        ),
      });

      const list = await agents.listAgents(WORKSPACE);
      const byId = new Map(list.map((a) => [a.id, a.lastSeenAt]));

      expect(byId.get(AGENT_ACTIVE)).toBeInstanceOf(Date);
      expect(byId.get(AGENT_IDLE)).toBeInstanceOf(Date);
      expect(byId.get(AGENT_DORMANT)).toBeNull();
      expect(byId.get(AGENT_FRESH)).toBeNull();
      expect(byId.has(AGENT_FOREIGN)).toBe(false);

      // The newest row wins, not just any row.
      const detail = await agents.getAgentDetail(WORKSPACE, AGENT_ACTIVE);
      expect(byId.get(AGENT_ACTIVE)?.getTime()).toBe(
        detail.recentRequestAt?.getTime(),
      );
    });
  },
);

describe.skipIf(!PROOF_URL)(
  "a hosted agent's gateway token never reaches a person (real PostgreSQL)",
  () => {
    // Seeded directly: the rule is about what READS and ROTATIONS return, not
    // about creation. A hosted agent's sandbox gets its token server-side;
    // a BYO agent's customer must hold theirs to configure their runtime.
    const HOSTED = `${P}token-hosted`;
    const BYO = `${P}token-byo`;
    const RUNNER = `${P}token-runner`;

    const seed = async () => {
      await db.runner.create({
        data: {
          id: RUNNER,
          name: RUNNER,
          token: `rnr_${RUNNER}`,
          capabilities: {
            maxSandboxes: 4,
            backend: "docker",
            homeDurability: "resident",
          },
          lastSeenAt: new Date(),
        },
      });
      await db.agent.create({
        data: {
          id: HOSTED,
          workspaceId: WORKSPACE,
          name: HOSTED,
          identifier: HOSTED,
          accessToken: `aoc_${HOSTED}`,
          kind: "hosted",
          harness: "jcode",
          sandbox: {
            create: {
              id: `${P}token-sbx`,
              runnerId: RUNNER,
              status: "running",
            },
          },
        },
      });
      await db.agent.create({
        data: {
          id: BYO,
          workspaceId: WORKSPACE,
          name: BYO,
          identifier: BYO,
          accessToken: `aoc_${BYO}`,
          kind: "byo",
        },
      });
    };
    const cleanup = async () => {
      await db.sandbox.deleteMany({ where: { id: `${P}token-sbx` } });
      await db.agent.deleteMany({ where: { id: { in: [HOSTED, BYO] } } });
      await db.runner.deleteMany({ where: { id: RUNNER } });
    };

    it("lists a hosted agent WITHOUT its token, and a BYO agent with it", async () => {
      await seed();
      try {
        const list = await agents.listAgents(WORKSPACE);
        const hosted = list.find((a) => a.id === HOSTED);
        const byo = list.find((a) => a.id === BYO);
        expect(hosted).toBeDefined();
        // Absent, not empty: a serialized response must not carry the key.
        expect(hosted && "accessToken" in hosted).toBe(false);
        expect(JSON.stringify(list)).not.toContain(`aoc_${HOSTED}`);
        expect(byo?.accessToken).toBe(`aoc_${BYO}`);
      } finally {
        await cleanup();
      }
    });

    it("rotates a hosted agent's token (and respawns it) without returning the new one", async () => {
      await seed();
      try {
        const result = await agents.regenerateAgentToken(WORKSPACE, HOSTED);
        expect(result).toEqual({ rotated: true });
        const row = await db.agent.findUniqueOrThrow({
          where: { id: HOSTED },
          select: { accessToken: true },
        });
        // Rotated for real: the old token no longer authenticates.
        expect(row.accessToken).not.toBe(`aoc_${HOSTED}`);
        expect(row.accessToken).toMatch(/^aoc_[0-9a-f]{64}$/);
        // The sandbox is told to pick the new one up: respawn re-provisions
        // it, and the next start composes a payload with the new token.
        const sandbox = await db.sandbox.findUniqueOrThrow({
          where: { agentId: HOSTED },
          select: { status: true },
        });
        expect(sandbox.status).toBe("unprovisioned");
      } finally {
        await cleanup();
      }
    });

    it("still returns a rotated BYO token: the customer configures their runtime with it", async () => {
      await seed();
      try {
        const result = await agents.regenerateAgentToken(WORKSPACE, BYO);
        const row = await db.agent.findUniqueOrThrow({
          where: { id: BYO },
          select: { accessToken: true },
        });
        expect(result).toEqual({ accessToken: row.accessToken });
        expect(row.accessToken).not.toBe(`aoc_${BYO}`);
      } finally {
        await cleanup();
      }
    });
  },
);

describe.skipIf(!PROOF_URL)(
  "the default-agent guard is gone (real PostgreSQL)",
  () => {
    it("deletes a legacy isDefault agent, the workspace's last one included", async () => {
      // The "Cannot delete the default agent" guard was retired: every
      // agent is deletable and a workspace with no agents is valid. A pre-v2
      // row still carrying isDefault must not resurrect it.
      const LONE_WS = `${P}proj-lone-default`;
      const LEGACY_DEFAULT = `${P}agent-legacy-default`;
      await db.workspace.create({
        data: { id: LONE_WS, name: LONE_WS, organizationId: ORG },
      });
      await db.agent.create({
        data: {
          id: LEGACY_DEFAULT,
          workspaceId: LONE_WS,
          name: LEGACY_DEFAULT,
          identifier: LEGACY_DEFAULT,
          accessToken: `aoc_${LEGACY_DEFAULT}`,
          isDefault: true,
        },
      });

      await expect(
        agents.deleteAgent(LONE_WS, LEGACY_DEFAULT),
      ).resolves.not.toThrow();
      expect(
        await db.agent.findUnique({ where: { id: LEGACY_DEFAULT } }),
      ).toBeNull();
      expect(await db.agent.count({ where: { workspaceId: LONE_WS } })).toBe(0);
    });
  },
);
