import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * CLI auth poll must hand out the workspace API key at most once. The unit
 * suite mocks the CAS boundary; this suite proves the race on real Postgres.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type CliAuth = typeof import("./cli-auth-service");

let db: Db;
let pollCliAuthSession: CliAuth["pollCliAuthSession"];

const P = "cli-auth-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const USER_EMAIL = `${P}user@example.invalid`;

const reset = async () => {
  await db.cliAuthSession.deleteMany({ where: { code: { startsWith: P } } });
  await db.apiKey.deleteMany({ where: { key: { startsWith: P } } });
  await db.user.deleteMany({ where: { email: USER_EMAIL } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";

  ({ db } = await import("@onecli/db"));
  ({ pollCliAuthSession } = await import("./cli-auth-service"));

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

describe.skipIf(!PROOF_URL)("pollCliAuthSession — concurrent consume", () => {
  it("hands out the api key to exactly one concurrent poll", async () => {
    const user = await db.user.create({
      data: {
        email: USER_EMAIL,
        externalAuthId: `ba:${randomBytes(8).toString("hex")}`,
      },
    });
    const apiKey = `${P}${randomBytes(32).toString("hex")}`;
    await db.apiKey.create({
      data: {
        key: apiKey,
        userId: user.id,
        userEmail: USER_EMAIL,
        workspaceId: WORKSPACE,
        kind: "user",
      },
    });

    const code = `${P}${randomBytes(8).toString("hex")}`;
    await db.cliAuthSession.create({
      data: {
        code,
        status: "confirmed",
        apiKey,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const [first, second] = await Promise.all([
      pollCliAuthSession(code),
      pollCliAuthSession(code),
    ]);

    const winners = [first, second].filter((r) => r.status === "ok");
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({
      status: "ok",
      api_key: apiKey,
      workspace_id: WORKSPACE,
    });

    const losers = [first, second].filter((r) => r.status !== "ok");
    expect(losers).toHaveLength(1);
    expect(losers[0]).toEqual({ status: "expired" });

    const row = await db.cliAuthSession.findUnique({ where: { code } });
    expect(row).toMatchObject({ status: "consumed", apiKey: null });
  });
});
