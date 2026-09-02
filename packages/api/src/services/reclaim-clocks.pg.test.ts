import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * The ceiling sweep's TWO clocks, proven against a real Postgres — in its own
 * file because the env freezes at module load per suite, and the sibling
 * suites pin TURN_CEILING_SECONDS=1800, where the two clocks coincide and a
 * regression to one shared clock would be invisible. Here the ceiling is the
 * production-shaped 6h, so the arms diverge: a never-started turn must still
 * fail on the OLD 30-minute bound (blocking a conversation for 6h to say
 * "nothing happened" is the regression this pins against), while a started
 * turn the same age is comfortably inside its work budget.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type DueWork = typeof import("./due-work");

let db: Db;
let dueWork: DueWork;

const P = "rcl-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;

const reset = async () => {
  await db.turn.deleteMany({
    where: { conversation: { id: { startsWith: P } } },
  });
  await db.conversation.deleteMany({ where: { id: { startsWith: P } } });
  await db.agent.deleteMany({ where: { id: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  // The point of this suite: a ceiling far above the never-started bound.
  process.env.TURN_CEILING_SECONDS = "21600";

  ({ db } = await import("@onecli/db"));
  dueWork = await import("./due-work");

  await reset();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: WORKSPACE, organizationId: ORG },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

/** A conversation + one turn row aged `minutes` back, started or not. */
const seedAgedTurn = async (
  suffix: string,
  minutes: number,
  started: boolean,
) => {
  const agentId = `${P}agent-${suffix}`;
  const conversationId = `${P}cv-${suffix}`;
  await db.agent.create({
    data: {
      id: agentId,
      workspaceId: WORKSPACE,
      name: agentId,
      identifier: agentId,
      accessToken: `agt_${P}${suffix}`,
      kind: "hosted",
    },
  });
  await db.conversation.create({
    data: { id: conversationId, agentId },
  });
  const turn = await db.turn.create({
    data: {
      conversationId,
      status: started ? "running" : "queued",
      message: "aged",
      ...(started && { startedAt: new Date() }),
    },
  });
  await db.$executeRaw`UPDATE turns SET created_at = now() - make_interval(mins => ${minutes}::int) WHERE id = ${turn.id}`;
  return turn.id;
};

describe.skipIf(!PROOF_URL)("the ceiling sweep's two clocks", () => {
  it("a never-started turn fails on the 30-minute bound, not the 6h ceiling", async () => {
    // MUTATION-PROOF for the CASE threshold: collapse both arms back to the
    // one ceiling clock and this row (40min old, ceiling 6h) is untouched.
    const turnId = await seedAgedTurn("cold", 40, false);

    await dueWork.reclaimStaleTurns();

    const row = await db.turn.findUnique({ where: { id: turnId } });
    expect(row?.status).toBe("failed");
    expect(row?.errorCode).toBe("agent_start_failed");
    expect(row?.abortRequested).toBe(false);
  });

  it("a STARTED turn the same age keeps its whole work budget", async () => {
    const turnId = await seedAgedTurn("warm", 40, true);

    await dueWork.reclaimStaleTurns();

    const row = await db.turn.findUnique({ where: { id: turnId } });
    expect(row?.status).toBe("running");
  });
});
