import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

// Self-hosted only, and the code under test reaches Prisma at module load —
// see the sibling adoption proof for why both pins have to be hoisted.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  const proofUrl = process.env.POLICY_PROOF_DATABASE_URL;
  if (proofUrl) process.env.DATABASE_URL = proofUrl;
});

import { randomUUID } from "node:crypto";
import { db } from "@onecli/db";
import { proofDatabaseUrl } from "../testing/pg-proof.js";
import { withoutLegacyLocalRow } from "../testing/scoped-prisma";
import { createOnpremAuth } from "./better-auth";

/**
 * That open registration is actually WIRED IN.
 *
 * The policy itself is unit-tested. What no unit test can show is what the
 * identity layer does with it: sign-up runs through a database hook the
 * library calls, and a regression there — a refusal creeping back in, or the
 * hook displacing the identity stamp — would leave every unit test green
 * while real deployments turned people away at the door. So this drives the
 * real library, over real rows, with the configuration production ships.
 *
 * The instance is seeded with existing accounts first: the point of
 * multi-user registration is precisely that an instance WITH users keeps
 * accepting new ones.
 *
 * The one refusal that still exists — the pre-2.0 upgrade window — has its
 * own wiring proof beside the adoption suite, which owns the placeholder-row
 * fixture. Here the placeholder lookup is scoped out
 * (`withoutLegacyLocalRow`) so that suite's fixture cannot flake this one on
 * the shared proof database.
 */

const PROOF_URL = proofDatabaseUrl();

const SECRET = "pg-proof-registration-secret-pg-proof-registration";
const BASE_URL = "http://127.0.0.1:10257";
const FIRST_EMAIL = `first-${randomUUID()}@example.invalid`;
const SECOND_EMAIL = `second-${randomUUID()}@example.invalid`;
const NEWCOMER_EMAIL = `newcomer-${randomUUID()}@example.invalid`;
const PASSWORD = "correct horse battery staple";

const seeded: string[] = [];

const seedUser = async (email: string) => {
  const user = await db.user.create({
    data: { email, externalAuthId: `ba:${randomUUID()}` },
  });
  seeded.push(user.id);
  return user;
};

describe.skipIf(!PROOF_URL)("open registration over real PostgreSQL", () => {
  beforeAll(async () => {
    // The state the old invite-only policy refused: an instance that already
    // has accounts. Open registration must accept a newcomer regardless.
    await seedUser(FIRST_EMAIL);
    await seedUser(SECOND_EMAIL);
  });

  afterAll(async () => {
    const users = await db.user.findMany({
      where: { email: { in: [FIRST_EMAIL, SECOND_EMAIL, NEWCOMER_EMAIL] } },
      select: { id: true },
    });
    const ids = [...new Set([...seeded, ...users.map((u) => u.id)])];
    await db.session.deleteMany({ where: { userId: { in: ids } } });
    await db.account.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  });

  it("accepts a sign-up on an instance that already has accounts", async () => {
    const auth = createOnpremAuth({
      secret: SECRET,
      baseURL: BASE_URL,
      prisma: withoutLegacyLocalRow(db),
    });

    const response = await auth.api.signUpEmail({
      body: { email: NEWCOMER_EMAIL, password: PASSWORD, name: "Newcomer" },
      asResponse: true,
    });

    expect(response.status).toBe(200);

    const created = await db.user.findUniqueOrThrow({
      where: { email: NEWCOMER_EMAIL },
    });
    // The identity every other service resolves users by is stamped in the
    // same creation hook — sign-up succeeding is not enough, the account has
    // to be resolvable by the API middleware and the gateway.
    expect(created.externalAuthId).toMatch(/^ba:/);
  });
});
