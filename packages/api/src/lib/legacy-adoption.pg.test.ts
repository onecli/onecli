import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// This is the SELF-HOSTED upgrade path, which cloud never runs. CI runs the
// suite with NEXT_PUBLIC_EDITION=cloud job-wide and edition reads resolve at
// module load, so pin it before any import evaluates or the adoption would
// refuse on its own first condition and every assertion here would be vacuous.
// The database URL is pinned here too, and for a subtler reason: this suite
// imports the code under test statically, and that module reaches the Prisma
// client at load — so setting DATABASE_URL in `beforeAll` would already be too
// late. `vi.hoisted` runs before any import evaluates.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  const proofUrl = process.env.POLICY_PROOF_DATABASE_URL;
  if (proofUrl) process.env.DATABASE_URL = proofUrl;
});

import { randomUUID } from "node:crypto";
import { db } from "@onecli/db";
import { proofDatabaseUrl } from "../testing/pg-proof.js";
import { adoptWithinTransaction, type TxClient } from "./legacy-adoption";
import { createOnpremAuth } from "./better-auth";
import { SIGNUP_BLOCKED_BY_UPGRADE } from "./registration";
import {
  LEGACY_LOCAL_AUTH_ID,
  LEGACY_LOCAL_EMAIL,
} from "./legacy-local-identity";

/**
 * The upgrade path, against real PostgreSQL.
 *
 * The unit suite proves what adoption REFUSES to do; a mocked client can do
 * that honestly. What it cannot speak to is the half that decided the design:
 * `User` is referenced by more than thirty relations, several of them
 * cascading, and the whole reason the legacy row survives rather than the
 * freshly created one is that deleting it would take an operator's agent
 * conversations with it. Only a real database can demonstrate that — and only
 * a real database can tell us the locking SELECT is valid SQL.
 *
 * So this suite builds a deployment the way a pre-2.0 install actually looks —
 * organization, workspace, agent, API key, a conversation the operator owns —
 * runs the adoption over it, and checks every one of those is still there
 * afterwards, under the operator's new identity, with the same user id.
 *
 * Env-gated like the other proof suites; see pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

const OPERATOR_EMAIL = `operator-${randomUUID()}@example.invalid`;
const FRESH_AUTH_ID = `ba:${randomUUID()}`;
const INTRUDER_EMAIL = `intruder-${randomUUID()}@example.invalid`;

interface Seeded {
  legacyUserId: string;
  freshUserId: string;
  organizationId: string;
  workspaceId: string;
  agentId: string;
  apiKeyId: string;
  conversationId: string;
  sessionToken: string;
  accountId: string;
}

let seeded: Seeded | null = null;

/**
 * A pre-2.0 deployment plus the account its operator is about to register.
 *
 * `admin@localhost` and `local-admin` are the literals the retired mode wrote,
 * and adoption keys on both, so they are used verbatim rather than randomised.
 * Everything else is unique per run so the shared proof database stays sane.
 */
const seed = async (): Promise<Seeded> => {
  const legacy = await db.user.create({
    data: {
      email: LEGACY_LOCAL_EMAIL,
      name: "Admin",
      externalAuthId: LEGACY_LOCAL_AUTH_ID,
    },
  });

  const organization = await db.organization.create({
    data: {
      name: "Admin",
      slug: `admin-${legacy.id.slice(0, 8)}`,
      members: {
        create: {
          userId: legacy.id,
          userEmail: LEGACY_LOCAL_EMAIL,
          role: "owner",
        },
      },
    },
  });

  const workspace = await db.workspace.create({
    data: {
      name: "Default",
      slug: "default",
      organizationId: organization.id,
      createdByUserId: legacy.id,
      createdByUserEmail: LEGACY_LOCAL_EMAIL,
    },
  });

  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      name: "Default Agent",
      identifier: "default",
      accessToken: `aoc_${randomUUID()}`,
    },
  });

  const apiKey = await db.apiKey.create({
    data: {
      workspaceId: workspace.id,
      userId: legacy.id,
      userEmail: LEGACY_LOCAL_EMAIL,
      name: "CLI",
      key: `oc_${randomUUID()}`,
    },
  });

  // The row that made "delete the legacy user" unacceptable: Conversation
  // cascades on its owner, so the operator's threads would simply vanish.
  const conversation = await db.conversation.create({
    data: { agentId: agent.id, userId: legacy.id, direct: true },
  });

  // ...and the account the identity layer creates when the operator registers.
  const fresh = await db.user.create({
    data: {
      email: OPERATOR_EMAIL,
      name: "Real Operator",
      externalAuthId: FRESH_AUTH_ID,
    },
  });
  const account = await db.account.create({
    data: {
      userId: fresh.id,
      // better-auth's own invariant for a password credential.
      accountId: fresh.id,
      providerId: "credential",
      password: "scrypt$not-a-real-hash",
    },
  });
  const sessionToken = randomUUID();
  await db.session.create({
    data: {
      userId: fresh.id,
      token: sessionToken,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return {
    legacyUserId: legacy.id,
    freshUserId: fresh.id,
    organizationId: organization.id,
    workspaceId: workspace.id,
    agentId: agent.id,
    apiKeyId: apiKey.id,
    conversationId: conversation.id,
    sessionToken,
    accountId: account.id,
  };
};

/**
 * Remove everything this suite could have created, from the identities rather
 * than from a record of what a run got as far as making.
 *
 * Keyed that way deliberately: a seed that throws halfway leaves rows behind,
 * and the legacy identity is unique-constrained, so the NEXT run would fail on
 * the leftovers rather than on its own behaviour. Adoption also rewrites the
 * legacy row's identity, so both are looked for.
 */
const purge = async () => {
  seeded = null;
  const users = await db.user.findMany({
    where: {
      OR: [
        { externalAuthId: { in: [LEGACY_LOCAL_AUTH_ID, FRESH_AUTH_ID] } },
        { email: { in: [OPERATOR_EMAIL, INTRUDER_EMAIL] } },
      ],
    },
    select: { id: true },
  });
  if (users.length === 0) return;
  const userIds = users.map((u) => u.id);

  const memberships = await db.organizationMember.findMany({
    where: { userId: { in: userIds } },
    select: { organizationId: true },
  });
  const orgIds = memberships.map((m) => m.organizationId);

  await db.conversation.deleteMany({ where: { userId: { in: userIds } } });
  if (orgIds.length > 0) {
    const workspaces = await db.workspace.findMany({
      where: { organizationId: { in: orgIds } },
      select: { id: true },
    });
    const workspaceIds = workspaces.map((p) => p.id);
    await db.conversation.deleteMany({
      where: { agent: { workspaceId: { in: workspaceIds } } },
    });
    await db.apiKey.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await db.agent.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await db.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await db.organizationMember.deleteMany({
      where: { organizationId: { in: orgIds } },
    });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
  }
  await db.apiKey.deleteMany({ where: { userId: { in: userIds } } });
  await db.session.deleteMany({ where: { userId: { in: userIds } } });
  await db.account.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
};

/**
 * The transaction client, with one question answered locally.
 *
 * Adoption asks "does this deployment have exactly two users?" — a question
 * about the whole table, which this proof database shares with a dozen other
 * suites running at the same time. That condition is proven exhaustively (and
 * mutation-tested) in the unit suite, where the count is deterministic. Here
 * it is answered for the two rows this test created so the REST of the
 * adoption — the lock, the foreign keys, the cascades, the rewrite — runs for
 * real against real rows, which is the only thing this file can prove.
 */
const withScopedUserCount = (tx: TxClient): TxClient =>
  ({
    ...tx,
    user: { ...tx.user, count: async () => 2 },
  }) as unknown as TxClient;

describe.skipIf(!PROOF_URL)(
  "legacy install adoption over real PostgreSQL",
  () => {
    beforeAll(purge);
    afterEach(purge);

    it("keeps every relation by keeping the operator's user id", async () => {
      seeded = await seed();
      const s = seeded;

      const adopted = await db.$transaction((tx) =>
        adoptWithinTransaction(withScopedUserCount(tx), FRESH_AUTH_ID),
      );
      expect(adopted).toBe(true);

      const user = await db.user.findUniqueOrThrow({
        where: { id: s.legacyUserId },
      });
      // The identity the operator registered with now belongs to the row that
      // owns everything — and it is the SAME row, which is the whole design.
      expect(user.email).toBe(OPERATOR_EMAIL);
      expect(user.name).toBe("Real Operator");
      expect(user.externalAuthId).toBe(FRESH_AUTH_ID);

      // The throwaway row is gone, so the instance has one account again.
      expect(
        await db.user.findUnique({ where: { id: s.freshUserId } }),
      ).toBeNull();

      // Everything the operator built is still theirs.
      expect(
        await db.organizationMember.findFirstOrThrow({
          where: { userId: s.legacyUserId },
        }),
      ).toMatchObject({ organizationId: s.organizationId, role: "owner" });
      expect(
        await db.workspace.findUnique({ where: { id: s.workspaceId } }),
      ).not.toBeNull();
      expect(
        await db.agent.findUnique({ where: { id: s.agentId } }),
      ).not.toBeNull();
      expect(
        await db.apiKey.findUnique({ where: { id: s.apiKeyId } }),
      ).not.toBeNull();
      // The cascade that decided which row survives: had the legacy user been
      // deleted, this would be gone and nothing would have reported it.
      expect(
        await db.conversation.findUnique({ where: { id: s.conversationId } }),
      ).toMatchObject({ userId: s.legacyUserId });
    });

    it("rewrites the copies of the email that are shown as who you are", async () => {
      seeded = await seed();
      const s = seeded;

      await db.$transaction((tx) =>
        adoptWithinTransaction(withScopedUserCount(tx), FRESH_AUTH_ID),
      );

      // These columns denormalise "the user's email" for display. Left alone,
      // the operator's own dashboard would keep calling them admin@localhost.
      expect(
        await db.organizationMember.findFirstOrThrow({
          where: { userId: s.legacyUserId },
        }),
      ).toMatchObject({ userEmail: OPERATOR_EMAIL });
      expect(
        await db.apiKey.findUniqueOrThrow({ where: { id: s.apiKeyId } }),
      ).toMatchObject({ userEmail: OPERATOR_EMAIL });
      expect(
        await db.workspace.findUniqueOrThrow({ where: { id: s.workspaceId } }),
      ).toMatchObject({ createdByUserEmail: OPERATOR_EMAIL });
    });

    it("carries the password and the open session across", async () => {
      seeded = await seed();
      const s = seeded;

      await db.$transaction((tx) =>
        adoptWithinTransaction(withScopedUserCount(tx), FRESH_AUTH_ID),
      );

      // The credential moved rather than being cascaded away with its old owner
      // — otherwise the operator's brand-new password would stop working the
      // instant they used it.
      const credential = await db.account.findUniqueOrThrow({
        where: { id: s.accountId },
      });
      expect(credential.userId).toBe(s.legacyUserId);
      // better-auth keeps a credential's accountId equal to the user id; the
      // move preserves that invariant rather than leaving a dangling id.
      expect(credential.accountId).toBe(s.legacyUserId);

      // And the cookie the browser is holding right now still resolves.
      expect(
        await db.session.findUniqueOrThrow({
          where: { token: s.sessionToken },
        }),
      ).toMatchObject({ userId: s.legacyUserId });
    });

    it("is self-disarming: a second attempt finds nothing to adopt", async () => {
      seeded = await seed();

      await db.$transaction((tx) =>
        adoptWithinTransaction(withScopedUserCount(tx), FRESH_AUTH_ID),
      );

      // Adoption overwrote the identity it keys on, so the locking SELECT's
      // predicate no longer matches anything — there is no way to run it twice.
      const again = await db.$transaction((tx) =>
        adoptWithinTransaction(withScopedUserCount(tx), FRESH_AUTH_ID),
      );
      expect(again).toBe(false);
    });

    it("the upgrade window refuses a second registrant, through the real sign-up", async () => {
      // Registration is open everywhere else; THIS is the one refusal left,
      // and it exists to protect the seeded state on this screen: the
      // placeholder plus the operator who registered for it. Were a third
      // account allowed in now, `adoptWithinTransaction` (exactly-two-rows
      // fence) could never run again and the old install's data would be
      // stranded. The guard lives in a database hook the auth library calls,
      // so only driving the real library proves it is wired in — placed in
      // this suite because it owns the placeholder-row fixture.
      seeded = await seed();

      const auth = createOnpremAuth({
        secret: "pg-proof-upgrade-window-secret-pg-proof-upgrade",
        baseURL: "http://127.0.0.1:10257",
      });

      const response = await auth.api.signUpEmail({
        body: {
          email: INTRUDER_EMAIL,
          password: "correct horse battery staple",
          name: "Intruder",
        },
        asResponse: true,
      });

      expect(response.status).toBe(403);
      // The code has to be OURS: the library's own failure mode is a generic
      // "failed to create user" a browser cannot tell apart from the
      // database being down.
      await expect(response.json()).resolves.toMatchObject({
        code: SIGNUP_BLOCKED_BY_UPGRADE,
      });

      // And nothing was created on the way to refusing.
      expect(
        await db.user.findUnique({ where: { email: INTRUDER_EMAIL } }),
      ).toBeNull();
    });
  },
);
