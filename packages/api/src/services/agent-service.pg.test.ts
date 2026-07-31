import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";
import { LAST_SEEN_WINDOW_MS } from "../lib/agent-activity.js";

/**
 * `getAgentDetail` on REAL PostgreSQL — the Install page's verify signal.
 * Laws: `recentRequestAt` reflects only requests inside the lookback window
 * (an older request reads as null, so the query stays bounded on the
 * (project_id, created_at) index), and the read is project-fenced — another
 * project's agent id is NOT_FOUND, never a cross-project disclosure (the
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
const PROJECT = `${P}proj`;
const OTHER_PROJECT = `${P}other-proj`;
const AGENT_ACTIVE = `${P}agent-active`;
const AGENT_IDLE = `${P}agent-idle`;
const AGENT_DORMANT = `${P}agent-dormant`;
const AGENT_FRESH = `${P}agent-fresh`;
const AGENT_FOREIGN = `${P}agent-foreign`;

const reset = async () => {
  await db.requestLog.deleteMany({ where: { projectId: { startsWith: P } } });
  await db.agent.deleteMany({ where: { id: { startsWith: P } } });
  await db.project.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

const requestLogRow = (agentId: string, createdAt: Date) => ({
  projectId: PROJECT,
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
  await db.project.create({
    data: { id: PROJECT, name: PROJECT, organizationId: ORG },
  });
  await db.project.create({
    data: { id: OTHER_PROJECT, name: OTHER_PROJECT, organizationId: ORG },
  });

  const agent = (id: string, projectId: string) =>
    db.agent.create({
      data: {
        id,
        projectId,
        name: id,
        identifier: id,
        accessToken: `aoc_${id}`,
        secretMode: "selective",
      },
    });
  await agent(AGENT_ACTIVE, PROJECT);
  await agent(AGENT_IDLE, PROJECT);
  await agent(AGENT_DORMANT, PROJECT);
  await agent(AGENT_FRESH, PROJECT);
  await agent(AGENT_FOREIGN, OTHER_PROJECT);
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

    const detail = await agents.getAgentDetail(PROJECT, AGENT_ACTIVE);
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

    const detail = await agents.getAgentDetail(PROJECT, AGENT_IDLE);
    expect(detail.recentRequestAt).toBeNull();
  });

  it("reads an agent with no requests at all as null", async () => {
    const detail = await agents.getAgentDetail(PROJECT, AGENT_FRESH);
    expect(detail.recentRequestAt).toBeNull();
  });

  it("does not attribute another agent's requests", async () => {
    // AGENT_ACTIVE has rows from the first test; AGENT_FRESH must stay null.
    const detail = await agents.getAgentDetail(PROJECT, AGENT_FRESH);
    expect(detail.recentRequestAt).toBeNull();
  });

  it("NOT_FOUNDs another project's agent id (cross-project control)", async () => {
    await expect(
      agents.getAgentDetail(PROJECT, AGENT_FOREIGN),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("NOT_FOUNDs an unknown agent id", async () => {
    await expect(
      agents.getAgentDetail(PROJECT, `${P}nope`),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe.skipIf(!PROOF_URL)(
  "listAgents lastSeenAt over real PostgreSQL",
  () => {
    it("attributes each agent its own newest in-window request, null otherwise", async () => {
      // World state from the suite above, plus a dormant fixture: ACTIVE has
      // recent rows; IDLE's only row is beyond the 7-day detail window but
      // inside the 30-day list window (the two windows are deliberately
      // different — this pins that); DORMANT's only row is beyond the list
      // window; FRESH has none; the foreign project's agent must not appear.
      await db.requestLog.create({
        data: requestLogRow(
          AGENT_DORMANT,
          new Date(Date.now() - LAST_SEEN_WINDOW_MS - 60 * 60 * 1000),
        ),
      });

      const list = await agents.listAgents(PROJECT);
      const byId = new Map(list.map((a) => [a.id, a.lastSeenAt]));

      expect(byId.get(AGENT_ACTIVE)).toBeInstanceOf(Date);
      expect(byId.get(AGENT_IDLE)).toBeInstanceOf(Date);
      expect(byId.get(AGENT_DORMANT)).toBeNull();
      expect(byId.get(AGENT_FRESH)).toBeNull();
      expect(byId.has(AGENT_FOREIGN)).toBe(false);

      // The newest row wins, not just any row.
      const detail = await agents.getAgentDetail(PROJECT, AGENT_ACTIVE);
      expect(byId.get(AGENT_ACTIVE)?.getTime()).toBe(
        detail.recentRequestAt?.getTime(),
      );
    });
  },
);
