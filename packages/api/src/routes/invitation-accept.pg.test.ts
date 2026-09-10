import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * Redeeming an invitation over the REAL HTTP surface against REAL PostgreSQL.
 *
 * The browser navigates on what this route returns: both the Join button and
 * the invited-signup hook read `organizationId` off the accept response and
 * land on `/org/<organizationId>/workspaces`. A mocked route test proves my
 * model of the response; only the real route over real rows proves the id
 * that comes back is the org the membership was actually written into.
 *
 * Env-gated like the other proof suites: skipped unless
 * POLICY_PROOF_DATABASE_URL points at a migrated PostgreSQL, e.g.
 *
 *   docker run -d --name join-proof-pg -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_DB=onecli -p 5441:5432 postgres:18-alpine
 *   DATABASE_URL="postgresql://postgres:postgres@localhost:5441/onecli" \
 *     pnpm --filter @onecli/db exec prisma migrate deploy
 *   POLICY_PROOF_DATABASE_URL="postgresql://postgres:postgres@localhost:5441/onecli" \
 *     pnpm --filter @onecli/api test -- --run src/routes/invitation-accept.pg.test.ts
 */

const PROOF_URL = proofDatabaseUrl();

// Dynamic imports: @onecli/db builds its client from DATABASE_URL at import
// time, so the env must be staged before anything pulls it in.
type Db = typeof import("@onecli/db").db;

let db: Db;
let app: Awaited<ReturnType<typeof import("../app.js").createApiApp>>;
let createInvitation: typeof import("../services/invitation-service.js").createInvitation;
let findAcceptedInvitationOrgForUser: typeof import("../services/invitation-service.js").findAcceptedInvitationOrgForUser;
let explainUnavailableInvitation: typeof import("../services/invitation-service.js").explainUnavailableInvitation;

const P = "joinproof-";
const ORG = `${P}org`;
const OWNER = `${P}owner`;
const INVITEE = `${P}invitee`;
const STRANGER = `${P}stranger`;
const email = (who: string) => `${who}@example.com`;

const accept = (who: string | null, token: string) =>
  app.request("/v1/invitations/accept", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(who ? { "x-test-user": who } : {}),
    },
    body: JSON.stringify({ token }),
  });

describe.skipIf(!PROOF_URL)(
  "POST /v1/invitations/accept (real PostgreSQL)",
  () => {
    beforeAll(async () => {
      process.env.DATABASE_URL = PROOF_URL;
      process.env.NEXT_PUBLIC_EDITION = "onprem";
      process.env.SECRET_ENCRYPTION_KEY =
        "7eeHVTcHkPw4rfI6wb0LSZje0mKDphzuz8QLocq0Egw=";
      process.env.OAUTH_STATE_SECRET = "proof-oauth-state-secret";

      ({ db } = await import("@onecli/db"));
      const { createApiApp } = await import("../app.js");
      ({
        createInvitation,
        findAcceptedInvitationOrgForUser,
        explainUnavailableInvitation,
      } = await import("../services/invitation-service.js"));

      // A session provider driven by a header the test controls, so a request
      // can act as any user without minting real better-auth tokens. The id is
      // the externalAuthId, exactly what the real provider hands the route.
      app = createApiApp({
        getSession: async (request: Request) => {
          const who = request.headers.get("x-test-user");
          return who ? { id: `${who}-auth`, email: email(who) } : null;
        },
      });
    });

    const purge = async () => {
      const workspaces = await db.workspace.findMany({
        where: { organizationId: ORG },
        select: { id: true },
      });
      const workspaceIds = workspaces.map((w) => w.id);
      await db.agent.deleteMany({
        where: { workspaceId: { in: workspaceIds } },
      });
      await db.apiKey.deleteMany({
        where: { workspaceId: { in: workspaceIds } },
      });
      await db.policyRuleV2.deleteMany({
        where: { workspaceId: { in: workspaceIds } },
      });
      await db.workspaceAccess.deleteMany({
        where: { workspaceId: { in: workspaceIds } },
      });
      await db.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await db.invitation.deleteMany({ where: { organizationId: ORG } });
      await db.auditLog.deleteMany({ where: { organizationId: ORG } });
      await db.organizationMember.deleteMany({
        where: { organizationId: ORG },
      });
      await db.organization.deleteMany({ where: { id: ORG } });
      await db.user.deleteMany({
        where: { id: { in: [OWNER, INVITEE, STRANGER] } },
      });
    };

    beforeEach(async () => {
      await purge();
      for (const who of [OWNER, INVITEE, STRANGER]) {
        await db.user.create({
          data: { id: who, email: email(who), externalAuthId: `${who}-auth` },
        });
      }
      await db.organization.create({
        data: {
          id: ORG,
          name: "Join Proof Org",
          slug: `${P}slug`,
          members: {
            create: { userId: OWNER, userEmail: email(OWNER), role: "owner" },
          },
        },
      });
    });

    afterAll(async () => {
      if (db) await purge();
    });

    const invite = () =>
      createInvitation({
        organizationId: ORG,
        email: email(INVITEE),
        role: "member",
        invitedById: OWNER,
        invitedByEmail: email(OWNER),
      });

    it("returns the organization id the browser lands on, and it IS the org the membership landed in", async () => {
      const { token } = await invite();

      const res = await accept(INVITEE, token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        organizationId: string;
        organizationName: string;
      };
      expect(body).toEqual({
        organizationId: ORG,
        organizationName: "Join Proof Org",
      });

      // `/org/<organizationId>/workspaces` is guarded by this exact lookup in
      // the org layout: the row must exist and not be suspended.
      const membership = await db.organizationMember.findUnique({
        where: {
          organizationId_userId: { organizationId: ORG, userId: INVITEE },
        },
        select: { status: true, role: true },
      });
      expect(membership).toEqual({ status: "active", role: "member" });

      // And the re-click path the /join page takes now resolves for them.
      expect(
        await findAcceptedInvitationOrgForUser(token, INVITEE, email(INVITEE)),
      ).toBe(ORG);
    });

    it("refuses a stranger holding the same link, without leaking the org name", async () => {
      const { token } = await invite();

      const res = await accept(STRANGER, token);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/different email address/i);
      expect(JSON.stringify(body)).not.toContain("Join Proof Org");

      // Nothing was written: still exactly the owner.
      expect(
        await db.organizationMember.count({ where: { organizationId: ORG } }),
      ).toBe(1);
      // And the link is still pending for its rightful holder.
      expect(await explainUnavailableInvitation(token)).toBe("unknown");
      expect((await accept(INVITEE, token)).status).toBe(200);
    });

    it("refuses the second use of a link the browser might replay", async () => {
      const { token } = await invite();
      expect((await accept(INVITEE, token)).status).toBe(200);

      const res = await accept(INVITEE, token);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /already been used/i,
      );
      // This is the moment /join takes over: the used link, re-clicked by its
      // accepter, resolves to the org instead of an error.
      expect(
        await findAcceptedInvitationOrgForUser(token, INVITEE, email(INVITEE)),
      ).toBe(ORG);
    });

    it("refuses an unauthenticated redeem outright", async () => {
      const { token } = await invite();
      const res = await accept(null, token);
      expect(res.status).toBe(401);
      expect(await explainUnavailableInvitation(token)).toBe("unknown");
    });
  },
);
