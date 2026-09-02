import { describe, expect } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { createOnpremAuth } from "@onecli/api/lib/better-auth";

import { scenario } from "../src/scenario.js";
import type { Cx } from "../src/scenario.js";

/**
 * The gateway validates self-hosted browser sessions on its own: it parses
 * the cookie, checks the signature, and reads the session row. Nothing in the
 * Rust code shares an implementation with the TypeScript that issues those
 * cookies — it hardcodes the format because it cannot import it.
 *
 * So this is the cross-language alarm. The cookie under test is minted by the
 * real auth library against this test's database, exactly as the API server
 * mints it, and then driven through the real gateway binary. A library
 * upgrade that changes the cookie name, the signature, or the session table
 * fails here — instead of silently signing out every self-hosted user.
 *
 * It also pins what the previous JWT-based scheme could not do: revocation is
 * immediate, because the gateway reads the same row that signing out deletes.
 */

const SECRET = "e2e-better-auth-secret-e2e-better-auth-secret";
const PASSWORD = "correct horse battery staple";

/** The gateway serves session cookies only on a self-hosted deployment.
 * The harness default IS the self-host edition now; what these scenarios add
 * is the shared cookie secret (and in-memory stores — the session arm needs
 * no Redis, and one lane deliberately proves it without). */
const ONPREM_SESSION = {
  expectedEdition: "Onprem",
  env: {
    REDIS_HOST: "",
    // The same secret the cookie is signed with: one shared value is the
    // whole basis for the gateway trusting a cookie it did not issue.
    BETTER_AUTH_SECRET: SECRET,
  },
} as const;

/**
 * Sign the seeded user in and return the cookie a browser would hold.
 *
 * The password credential is written directly (with the library's own
 * hasher) so the scenario's pre-seeded user is the one signing in. From
 * there this is an ordinary sign-in: the library mints the session row and
 * signs the cookie exactly as it would in production, and — because the user
 * already exists — nothing here depends on new-user provisioning.
 */
const signInSeededUser = async (cx: Cx): Promise<string> => {
  const auth = createOnpremAuth({
    prisma: cx.db.prisma,
    secret: SECRET,
    baseURL: "http://127.0.0.1:10256",
  });

  const user = await cx.db.prisma.user.findUniqueOrThrow({
    where: { id: cx.ids.user },
  });
  await cx.db.prisma.account.create({
    data: {
      userId: user.id,
      accountId: user.id,
      providerId: "credential",
      password: await hashPassword(PASSWORD),
    },
  });

  const response = await auth.api.signInEmail({
    body: { email: user.email, password: PASSWORD },
    asResponse: true,
  });
  expect(response.status).toBe(200);

  const setCookie = response.headers.getSetCookie();
  expect(setCookie.length).toBeGreaterThan(0);
  return setCookie.map((c) => c.split(";")[0]).join("; ");
};

const authOver = (cx: Cx) =>
  createOnpremAuth({
    prisma: cx.db.prisma,
    secret: SECRET,
    baseURL: "http://127.0.0.1:10256",
  });

describe("self-hosted session cookies at the gateway", () => {
  scenario("accepts a cookie the auth server actually issued", async (cx) => {
    await cx.seed({ withApiKey: true });
    const gw = await cx.startGateway(ONPREM_SESSION);

    const cookie = await signInSeededUser(cx);
    // The name the gateway looks for is not configurable at its end.
    expect(cookie).toContain("better-auth.session_token=");

    const res = await fetch(`${gw.origin}/me`, { headers: { cookie } });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(cx.ids.user);
  });

  scenario(
    "a stray Cognito pool id in a self-host env does not flip the auth arm",
    async (cx) => {
      await cx.seed({ withApiKey: true });

      // EDITION=onprem with a STRAY COGNITO_USER_POOL_ID set: a shared
      // self-host .env can carry a pool id it never uses, and the session
      // cookie must still validate. The selector is the edition, not config
      // presence; before the edition gate this request 401'd.
      const gw = await cx.startGateway({
        expectedEdition: "Onprem",
        env: {
          COGNITO_USER_POOL_ID: "us-east-1_e2e",
          REDIS_HOST: "",
          BETTER_AUTH_SECRET: SECRET,
        },
      });

      const cookie = await signInSeededUser(cx);
      const res = await fetch(`${gw.origin}/me`, { headers: { cookie } });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe(cx.ids.user);
    },
  );

  scenario("stops accepting it the moment the user signs out", async (cx) => {
    await cx.seed({ withApiKey: true });
    const gw = await cx.startGateway(ONPREM_SESSION);
    const cookie = await signInSeededUser(cx);

    expect(
      (await fetch(`${gw.origin}/me`, { headers: { cookie } })).status,
    ).toBe(200);

    await authOver(cx).api.signOut({ headers: new Headers({ cookie }) });

    // The cookie is untouched and still correctly signed — but the row behind
    // it is gone, and the gateway reads the row. A self-contained token would
    // have kept working until it expired.
    const res = await fetch(`${gw.origin}/me`, { headers: { cookie } });
    expect(res.status).toBe(401);
  });

  scenario("refuses a session that has passed its expiry", async (cx) => {
    await cx.seed({ withApiKey: true });
    const gw = await cx.startGateway(ONPREM_SESSION);
    const cookie = await signInSeededUser(cx);

    expect(
      (await fetch(`${gw.origin}/me`, { headers: { cookie } })).status,
    ).toBe(200);

    // Expired rows are only cleaned up when their own token is presented
    // again, so the row is still there — the gateway has to reject it on the
    // timestamp rather than on absence.
    await cx.db.prisma.session.updateMany({
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const res = await fetch(`${gw.origin}/me`, { headers: { cookie } });
    expect(res.status).toBe(401);
  });

  scenario("an unconfigured install admits nobody", async (cx) => {
    await cx.seed({ withApiKey: true });

    // Plant the identity the retired no-login mode resolved everyone to, and
    // give it an organization so it WOULD authenticate successfully. Until
    // this release the gateway had a third arm that looked exactly this row
    // up whenever no secret was configured, and an anonymous request came
    // back 200 as the admin. Nothing may reintroduce that: a deployment that
    // cannot verify a session serves nobody, whatever rows exist.
    const seeded = await cx.db.prisma.user.findUniqueOrThrow({
      where: { id: cx.ids.user },
    });
    const localAdmin = await cx.db.prisma.user.create({
      data: {
        email: "admin@localhost",
        name: "Admin",
        externalAuthId: "local-admin",
      },
    });
    const membership = await cx.db.prisma.organizationMember.findFirstOrThrow({
      where: { userId: seeded.id },
    });
    await cx.db.prisma.organizationMember.create({
      data: {
        organizationId: membership.organizationId,
        userId: localAdmin.id,
        userEmail: localAdmin.email,
        role: "owner",
      },
    });

    const gw = await cx.startGateway({
      expectedEdition: "Onprem",
      env: {
        REDIS_HOST: "",
        BETTER_AUTH_SECRET: "",
      },
    });

    const res = await fetch(`${gw.origin}/me`);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toBe(localAdmin.id);
  });

  scenario("refuses forged and unsigned cookies", async (cx) => {
    await cx.seed({ withApiKey: true });
    const gw = await cx.startGateway(ONPREM_SESSION);
    const cookie = await signInSeededUser(cx);

    const rawToken = decodeURIComponent(
      cookie.split("better-auth.session_token=")[1] ?? "",
    ).split(".")[0];
    expect(rawToken).toBeTruthy();

    // A real, live session token presented WITHOUT the signature that proves
    // the server issued it — what someone who obtained a token would send.
    const unsigned = `better-auth.session_token=${rawToken}`;
    expect(
      (await fetch(`${gw.origin}/me`, { headers: { cookie: unsigned } }))
        .status,
    ).toBe(401);

    // The same token with a well-formed signature made from another secret.
    const forged = `better-auth.session_token=${encodeURIComponent(
      `${rawToken}.${"A".repeat(43)}=`,
    )}`;
    expect(
      (await fetch(`${gw.origin}/me`, { headers: { cookie: forged } })).status,
    ).toBe(401);
  });
});
