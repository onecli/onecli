import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// This is the SELF-HOSTED identity layer, and cloud never builds it — the
// api-server wires Cognito's session provider there instead. CI runs the
// suite with NEXT_PUBLIC_EDITION=cloud job-wide and edition reads resolve at
// module load, so pin it before any import evaluates or every assertion here
// would silently read as "not signed in".
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * The self-hosted session, end to end, against real PostgreSQL.
 *
 * The unit suite mocks the auth library, so it proves the mapping and nothing
 * else. What actually breaks in production is the wire: a session issued by
 * the API must come back through the very same cookie the browser stores, and
 * the row behind it must be readable — and revocable — from the database.
 *
 * So this suite drives the real library over real rows. It signs a user in,
 * takes the `Set-Cookie` the API would have sent, and hands it to the session
 * provider as a browser would. A library upgrade that changes the cookie
 * name, the signature format, or the session table fails here rather than
 * silently signing everyone out in production.
 *
 * It also pins the two properties the JWT-based predecessor could not offer:
 * the identity is our `externalAuthId` (stamped on rows the library creates),
 * and signing out invalidates the cookie IMMEDIATELY — the row is gone, so
 * there is no token lifetime left to wait out.
 *
 * Env-gated like the other proof suites; see pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;

const SECRET = "pg-proof-better-auth-secret-pg-proof-better-auth";
const BASE_URL = "http://127.0.0.1:10256";
const EMAIL = "session-proof@example.invalid";
const PASSWORD = "correct horse battery staple";

let db: Db;
let auth: ReturnType<typeof import("./better-auth").createOnpremAuth>;
let provider: typeof import("./onprem-session-provider").onpremSessionProvider;

/** Everything this suite writes, keyed so cleanup can find it. */
const cleanup = async () => {
  const user = await db.user.findUnique({ where: { email: EMAIL } });
  if (!user) return;
  await db.session.deleteMany({ where: { userId: user.id } });
  await db.account.deleteMany({ where: { userId: user.id } });
  const memberships = await db.organizationMember.findMany({
    where: { userId: user.id },
    select: { organizationId: true },
  });
  const orgIds = memberships.map((m) => m.organizationId);
  await db.organizationMember.deleteMany({ where: { userId: user.id } });
  if (orgIds.length > 0) {
    await db.agent.deleteMany({
      where: { workspace: { organizationId: { in: orgIds } } },
    });
    await db.apiKey.deleteMany({ where: { userId: user.id } });
    await db.policyRuleV2.deleteMany({
      where: { workspace: { organizationId: { in: orgIds } } },
    });
    await db.workspace.deleteMany({
      where: { organizationId: { in: orgIds } },
    });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
  }
  await db.user.delete({ where: { id: user.id } });
};

/** The cookie header a browser would send back, from a Set-Cookie response. */
const cookieHeaderFrom = (response: Response): string => {
  const setCookie = response.headers.getSetCookie();
  expect(setCookie.length).toBeGreaterThan(0);
  return setCookie.map((c) => c.split(";")[0]).join("; ");
};

const requestWithCookie = (cookie: string) =>
  new Request(`${BASE_URL}/v1/user`, { headers: { cookie } });

describe.skipIf(!PROOF_URL)("self-hosted session over real PostgreSQL", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = PROOF_URL;
    process.env.BETTER_AUTH_SECRET = SECRET;

    ({ db } = await import("@onecli/db"));
    // The server does this at boot, and provisioning an organization depends
    // on it — without it the bootstrap throws. Run it here so the suite
    // exercises what production runs rather than a degraded version of it.
    const { ensureEditionDefaults } = await import("../edition-defaults");
    ensureEditionDefaults();

    const { createOnpremAuth } = await import("./better-auth");
    const { withoutLegacyLocalRow } = await import("../testing/scoped-prisma");
    ({ onpremSessionProvider: provider } =
      await import("./onprem-session-provider"));

    // This suite asserts the session WIRE, not the upgrade-window guard, and
    // it runs against a proof database shared with the adoption suite, whose
    // placeholder-row fixture would make the guard refuse this sign-up for
    // reasons unrelated to anything here. Everything the assertions depend
    // on — the secret, the cookie name, the session row — is identical.
    auth = createOnpremAuth({
      secret: SECRET,
      baseURL: BASE_URL,
      prisma: withoutLegacyLocalRow(db),
    });

    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("resolves a cookie the auth API issued into our own identity", async () => {
    const response = await auth.api.signUpEmail({
      body: { email: EMAIL, password: PASSWORD, name: "Session Proof" },
      asResponse: true,
    });
    expect(response.status).toBe(200);

    const cookie = cookieHeaderFrom(response);
    // The name the browser stores must be the one the gateway looks for.
    expect(cookie).toContain("better-auth.session_token=");

    const session = await provider.getSession(requestWithCookie(cookie));

    const user = await db.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(user.externalAuthId).toBeTruthy();
    // The library created this row, so the identity every other service
    // resolves users by has to have been stamped on it.
    expect(session).toMatchObject({
      id: user.externalAuthId,
      email: EMAIL,
    });
    // ...and it is NOT the library's own row id, which resolves to nobody.
    expect(session?.id).not.toBe(user.id);
  });

  it("gives the new user somewhere to land, and repairs one who has nowhere", async () => {
    // The identity layer creates the user row during sign-in, so the session
    // sync always sees a pre-existing user. Provisioning is therefore keyed
    // on "has no organization" rather than "was just created" — which also
    // makes it self-healing, the property this asserts.
    const user = await db.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(
      await db.organizationMember.findFirst({ where: { userId: user.id } }),
    ).toBeNull();

    const { authSessionRoutes, initSessionHooks } =
      await import("../routes/auth-session");
    const { initSession } = await import("../providers");
    const { onpremSessionHooks } = await import("./onprem-session-hooks");

    initSession({
      getSession: async () => provider.getSession(new Request(BASE_URL)),
    });
    initSessionHooks(onpremSessionHooks);

    const signIn = await auth.api.signInEmail({
      body: { email: EMAIL, password: PASSWORD },
      asResponse: true,
    });
    const cookie = cookieHeaderFrom(signIn);
    initSession({
      getSession: async () => provider.getSession(requestWithCookie(cookie)),
    });

    const res = await authSessionRoutes().request("/");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ email: EMAIL });

    const membership = await db.organizationMember.findFirstOrThrow({
      where: { userId: user.id },
    });
    // A workspace too, not just the organization row — a half-provisioned
    // account would otherwise look exactly like a healthy one here.
    expect(
      await db.workspace.findFirst({
        where: { organizationId: membership.organizationId },
      }),
    ).not.toBeNull();

    initSessionHooks({});
  });

  it("stops accepting the cookie the moment the session is revoked", async () => {
    const response = await auth.api.signInEmail({
      body: { email: EMAIL, password: PASSWORD },
      asResponse: true,
    });
    expect(response.status).toBe(200);
    const cookie = cookieHeaderFrom(response);

    expect(await provider.getSession(requestWithCookie(cookie))).not.toBeNull();

    await auth.api.signOut({ headers: new Headers({ cookie }) });

    // Same cookie, still perfectly signed — but the row behind it is gone.
    // A stateless token would have stayed valid until it expired.
    expect(await provider.getSession(requestWithCookie(cookie))).toBeNull();
  });

  it("refuses a cookie whose signature does not hold", async () => {
    const response = await auth.api.signInEmail({
      body: { email: EMAIL, password: PASSWORD },
      asResponse: true,
    });
    const cookie = cookieHeaderFrom(response);
    const tampered =
      cookie.replace("better-auth.session_token=", (m) => m) + "x";

    expect(await provider.getSession(requestWithCookie(tampered))).toBeNull();
  });
});
