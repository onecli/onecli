import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * WHICH agent `GET /v1/container-config` resolves when the caller omits
 * `agent=`, on REAL PostgreSQL — the CLI's whole contract for an unpinned
 * machine.
 *
 * Omission is the LEGACY arm: a pre-v2 workspace's deprecated default agent
 * (`Agent.isDefault`, never written anymore) keeps resolving so already-
 * configured machines stay working. Everyone else gets a distinguishable
 * miss — the route answers AGENT_REQUIRED (agents exist, none flagged) or
 * NO_AGENTS (empty workspace) — and nothing is ever auto-created. The real
 * resolver is imported rather than mirrored so this proof cannot drift from
 * the route.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type ResolveAgent =
  typeof import("../services/container-config-service.js").resolveContainerConfigAgent;

let db: Db;
let resolveAgent: ResolveAgent;

const P = "cagt-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`; // pre-v2 shape: carries a legacy default
const UNPINNED_WORKSPACE = `${P}unpinned`; // post-v2 shape: agents, no default
const EMPTY_WORKSPACE = `${P}empty`;

const seedAgent = async (
  id: string,
  createdAt: Date,
  opts: { workspaceId?: string; isDefault?: boolean } = {},
) =>
  db.agent.create({
    data: {
      id,
      workspaceId: opts.workspaceId ?? WORKSPACE,
      name: id,
      identifier: id,
      accessToken: `aoc_${id}`,
      createdAt,
      // Omitted = NULL, the state every new agent is born with.
      ...(opts.isDefault === undefined ? {} : { isDefault: opts.isDefault }),
    },
  });

const reset = async () => {
  await db.agent.deleteMany({ where: { id: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  ({ resolveContainerConfigAgent: resolveAgent } =
    await import("../services/container-config-service.js"));
  await reset();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  for (const id of [WORKSPACE, UNPINNED_WORKSPACE, EMPTY_WORKSPACE]) {
    await db.workspace.create({
      data: { id, name: id, organizationId: ORG },
    });
  }

  // The legacy workspace: the flagged agent is deliberately the MIDDLE-aged one,
  // with an OLDER explicit-false sibling and a NEWER null sibling — the flag
  // must beat age in both directions, and false/NULL must both stay invisible.
  await seedAgent(`${P}older`, new Date("2026-01-01T00:00:00Z"), {
    isDefault: false,
  });
  await seedAgent(`${P}legacy`, new Date("2026-02-01T00:00:00Z"), {
    isDefault: true,
  });
  await seedAgent(`${P}newest`, new Date("2026-03-01T00:00:00Z"));

  // The post-v2 workspace: agents exist, none was ever flagged.
  await seedAgent(`${P}unpinned-a`, new Date("2026-04-01T00:00:00Z"), {
    workspaceId: UNPINNED_WORKSPACE,
    isDefault: false,
  });
  await seedAgent(`${P}unpinned-b`, new Date("2026-05-01T00:00:00Z"), {
    workspaceId: UNPINNED_WORKSPACE,
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

describe.skipIf(!PROOF_URL)("container-config agent resolution", () => {
  it("omitting `agent=` resolves the legacy default, not the oldest agent", async () => {
    expect(await resolveAgent(WORKSPACE)).toEqual({
      outcome: "resolved",
      agent: { id: `${P}legacy`, accessToken: `aoc_${P}legacy` },
    });
  });

  it("stays on the legacy default when a newer agent is created", async () => {
    await seedAgent(`${P}later`, new Date("2026-06-01T00:00:00Z"));
    // Creating an agent must never silently re-point a machine that was
    // already resolving.
    expect(await resolveAgent(WORKSPACE)).toMatchObject({
      agent: { id: `${P}legacy` },
    });
    await db.agent.delete({ where: { id: `${P}later` } });
  });

  it("several flagged rows resolve the OLDEST default, deterministically", async () => {
    // The schema never enforced single-default (only the retired set-default
    // transaction did), so the pathological state must not resolve by
    // Postgres's whim.
    await db.agent.update({
      where: { id: `${P}newest` },
      data: { isDefault: true },
    });
    expect(await resolveAgent(WORKSPACE)).toMatchObject({
      agent: { id: `${P}legacy` },
    });
    await db.agent.update({
      where: { id: `${P}newest` },
      data: { isDefault: null },
    });
  });

  it("`agent=` still wins over the legacy default", async () => {
    expect(await resolveAgent(WORKSPACE, `${P}newest`)).toMatchObject({
      agent: { id: `${P}newest` },
    });
  });

  it("an unknown identifier is its own outcome, not a fallback", async () => {
    expect(await resolveAgent(WORKSPACE, `${P}nope`)).toEqual({
      outcome: "identifier-not-found",
    });
  });

  it("agents but no legacy default is the AGENT_REQUIRED arm", async () => {
    // Every post-v2 workspace: omission has nothing to mean — the route tells
    // the caller to pass an agent, and must NOT invent or guess one. Also the
    // planted cross-workspace negative control: a flagged agent exists in the
    // sibling WORKSPACE, and it must stay invisible to this workspace's fence.
    expect(await resolveAgent(UNPINNED_WORKSPACE)).toEqual({
      outcome: "no-legacy-default",
      hasAgents: true,
    });
  });

  it("a workspace with no agents is the NO_AGENTS arm", async () => {
    // The route answers 404 NO_AGENTS here. It used to CREATE an agent, which
    // is what made an empty workspace impossible to reach.
    expect(await resolveAgent(EMPTY_WORKSPACE)).toEqual({
      outcome: "no-legacy-default",
      hasAgents: false,
    });
  });
});
