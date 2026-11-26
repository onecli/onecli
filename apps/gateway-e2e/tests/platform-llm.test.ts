import { describe, expect } from "vitest";

import { scenario } from "../src/scenario.js";
import { throughProxy } from "../src/proxy.js";

/**
 * The platform Anthropic trial credit (`ee/platform_llm.rs`), black-box.
 *
 * THE cloud arm of the suite: the trial credit is cloud-only wire behavior
 * (`parse` returns None off-cloud), so these scenarios override the harness's
 * enterprise default with `EDITION=cloud` — which also pins the cloud boot
 * posture end to end (the fail-fast wants Cognito/Redis/KMS configured; the
 * dummies below satisfy it, and neither is ever dialed: sessions stay on
 * agent tokens, and the harness's SECRET_ENCRYPTION_KEY selects the local
 * AES crypto backend by config precedence).
 *
 * The binary runs with `PLATFORM_ANTHROPIC_API_KEY` set and the injection
 * host overridden to the local stub (`PLATFORM_ANTHROPIC_API_HOST` —
 * production resolves api.anthropic.com). What these prove end to end:
 *
 *  - a keyless org gets the PLATFORM's key injected in the standard
 *    Anthropic shape (x-api-key set, client authorization removed);
 *  - any LLM key of the org's own stands the platform key down — even when
 *    that key is NOT granted to the requesting agent (a restriction is never
 *    bypassed with free credit);
 *  - a spent credit blocks with the trial_credit_exhausted 403 (seeded via the
 *    durable floor, exactly how a restarted gateway re-learns spend);
 *  - the credit is keyed to the org's founding OWNER, so a second org by the
 *    same user shares the exhausted pool (the "new org, fresh $5" hole);
 *  - only a trusted owner gets it: a Google sign-in (any address) or any
 *    address that is not a consumer Microsoft mailbox. An outlook.com owner,
 *    or an org with no active owner, gets no platform key at all.
 */

const PLATFORM_KEY = "sk-ant-api03-platform-e2e";

/** The cloud spawn env, layered per scenario (some drop the platform key). */
const CLOUD_ENV = {
  EDITION: "cloud",
  COGNITO_USER_POOL_ID: "us-east-1_e2e",
  KMS_KEY_ARN: "arn:aws:kms:us-east-1:000000000000:key/e2e-never-dialed",
} as const;

const CLOUD = { env: CLOUD_ENV, expectedEdition: "Cloud" } as const;

const platformEnv = {
  ...CLOUD_ENV,
  PLATFORM_ANTHROPIC_API_KEY: PLATFORM_KEY,
  // The e2e upstreams live on 127.0.0.1; production leaves this unset.
  PLATFORM_ANTHROPIC_API_HOST: "127.0.0.1",
} as const;

type Cx = Parameters<Parameters<typeof scenario>[1]>[0];

/**
 * Make `ids.user` the org's founding owner, with the given address and
 * recorded sign-in provider (`users.sign_in_provider`). Every address used
 * below is made up.
 */
const seedOwner = async (
  cx: Cx,
  email: string,
  signInProvider: string | null = null,
) => {
  await cx.db.prisma.user.create({
    data: {
      id: cx.ids.user,
      email,
      externalAuthId: cx.ids.user,
      signInProvider,
    },
  });
  await cx.db.prisma.organizationMember.create({
    data: {
      organizationId: cx.ids.org,
      userId: cx.ids.user,
      userEmail: email,
      role: "owner",
    },
  });
};

describe("platform trial credit (cloud edition)", () => {
  scenario("injects the platform key for a keyless org", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed(); // no secrets, no grants — a brand-new user's world
    await seedOwner(cx, `${cx.ids.nonce}@company.example`);
    const gw = await cx.startGateway({
      env: platformEnv,
      expectedEdition: "Cloud",
    });

    const res = await throughProxy(gw.origin, {
      url: upstream.url("/v1/messages"),
      token: cx.ids.agentToken,
      headers: { authorization: "Bearer client-supplied-token" },
    });
    expect(res.status).toBe(200);

    const [seen] = await upstream.waitForRequests(1);
    expect(seen?.header("x-api-key")).toBe(PLATFORM_KEY);
    // The standard Anthropic injection shape: the client's own authorization
    // must not reach Anthropic alongside the key.
    expect(seen?.header("authorization")).toBeUndefined();
  });

  scenario("does not inject without the env key", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed();
    await seedOwner(cx, `${cx.ids.nonce}@company.example`);
    const gw = await cx.startGateway(CLOUD); // no PLATFORM_ANTHROPIC_API_KEY

    await throughProxy(gw.origin, {
      url: upstream.url("/v1/messages"),
      token: cx.ids.agentToken,
    });

    const [seen] = await upstream.waitForRequests(1);
    expect(seen?.header("x-api-key")).toBeUndefined();
  });

  scenario(
    "without the host override, only api.anthropic.com qualifies",
    async (cx) => {
      // The production shape: key set, host NOT overridden. The stub is not
      // api.anthropic.com, so nothing must inject — proving the earlier
      // scenarios hit the stub because of the override, not a loose match.
      const upstream = await cx.upstream();
      await cx.seed();
      await seedOwner(cx, `${cx.ids.nonce}@company.example`);
      const gw = await cx.startGateway({
        env: { ...CLOUD_ENV, PLATFORM_ANTHROPIC_API_KEY: PLATFORM_KEY },
        expectedEdition: "Cloud",
      });

      await throughProxy(gw.origin, {
        url: upstream.url("/v1/messages"),
        token: cx.ids.agentToken,
      });

      const [seen] = await upstream.waitForRequests(1);
      expect(seen?.header("x-api-key")).toBeUndefined();
    },
  );

  scenario(
    "an org's own LLM key stands the platform key down — even ungranted",
    async (cx) => {
      const upstream = await cx.upstream();
      // The org HAS an OpenAI key, deliberately NOT granted to this agent
      // (no grantAll): the agent itself is keyless, but the platform credit
      // must not paper over the restriction.
      await cx.seed({
        secrets: [
          { type: "openai", hostPattern: "api.openai.com", value: "sk-own" },
        ],
      });
      const gw = await cx.startGateway({
        env: platformEnv,
        expectedEdition: "Cloud",
      });

      await throughProxy(gw.origin, {
        url: upstream.url("/v1/messages"),
        token: cx.ids.agentToken,
      });

      const [seen] = await upstream.waitForRequests(1);
      expect(seen?.header("x-api-key")).toBeUndefined();
    },
  );

  scenario(
    "blocks with trial_credit_exhausted once the credit is spent",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed();
      await seedOwner(cx, `${cx.ids.nonce}@company.example`);
      // Spend the whole credit via the durable floor — the same row a running
      // gateway persists and a restarted one rehydrates enforcement from. The
      // grant subject is the founding owner's USER (`user:<id>` — the column
      // carries a rendered BudgetSubject, never a bare id).
      await cx.db.prisma.budgetSpend.create({
        data: {
          secretId: "platform:anthropic",
          organizationId: `user:${cx.ids.user}`,
          period: "total",
          // $5 in nano-dollars — exactly the default limit, and >= is a block.
          spentNanos: 5_000_000_000n,
        },
      });
      const gw = await cx.startGateway({
        env: platformEnv,
        expectedEdition: "Cloud",
      });

      const res = await throughProxy(gw.origin, {
        url: upstream.url("/v1/messages"),
        token: cx.ids.agentToken,
      });

      expect(res.status).toBe(403);
      const body = JSON.parse(res.body) as {
        error: string;
        message: string;
        period: string;
      };
      // The platform arm's OWN wire code — the sandbox supervisor keys its
      // friendly add-a-key classification on it, while an admin-configured
      // org budget keeps `budget_exceeded` (and the raw passthrough).
      expect(body.error).toBe("trial_credit_exhausted");
      expect(body.period).toBe("total");
      // The trial-credit wording, not the org-budget one: the fix is bringing
      // your own key.
      expect(body.message).toContain("trial credit");
      // Nothing was forwarded upstream.
      expect(upstream.requests()).toHaveLength(0);
    },
  );

  scenario(
    "the credit follows the founding owner across their orgs",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed();
      // Make ids.user the org's founding owner...
      await seedOwner(cx, `${cx.ids.nonce}-owner@company.example`);
      // ...whose lifetime credit is already spent (as if in an earlier org:
      // the spend row keys on the USER subject, not this org).
      await cx.db.prisma.budgetSpend.create({
        data: {
          secretId: "platform:anthropic",
          organizationId: `user:${cx.ids.user}`,
          period: "total",
          spentNanos: 5_000_000_000n,
        },
      });
      const gw = await cx.startGateway({
        env: platformEnv,
        expectedEdition: "Cloud",
      });

      const res = await throughProxy(gw.origin, {
        url: upstream.url("/v1/messages"),
        token: cx.ids.agentToken,
      });

      // A fresh org, but the same exhausted user pool: no fresh $5.
      expect(res.status).toBe(403);
      expect((JSON.parse(res.body) as { error: string }).error).toBe(
        "trial_credit_exhausted",
      );
    },
  );

  scenario(
    "an outlook.com owner gets no platform key (a consumer Microsoft mailbox)",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed();
      await seedOwner(cx, `AlexKim${cx.ids.nonce.slice(0, 6)}@outlook.com`);
      const gw = await cx.startGateway({
        env: platformEnv,
        expectedEdition: "Cloud",
      });

      const res = await throughProxy(gw.origin, {
        url: upstream.url("/v1/messages"),
        token: cx.ids.agentToken,
      });

      // Forwarded untouched, exactly like an org with no credit at all: no
      // platform key, and no budget 403 either (the credit never applied).
      expect(res.status).toBe(200);
      const [seen] = await upstream.waitForRequests(1);
      expect(seen?.header("x-api-key")).toBeUndefined();
    },
  );

  scenario(
    "a Google sign-in owner gets it even on an outlook.com address",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed();
      await seedOwner(
        cx,
        `AlexKim${cx.ids.nonce.slice(0, 6)}@outlook.com`,
        "Google",
      );
      const gw = await cx.startGateway({
        env: platformEnv,
        expectedEdition: "Cloud",
      });

      await throughProxy(gw.origin, {
        url: upstream.url("/v1/messages"),
        token: cx.ids.agentToken,
      });

      const [seen] = await upstream.waitForRequests(1);
      expect(seen?.header("x-api-key")).toBe(PLATFORM_KEY);
    },
  );

  scenario("an org with no active owner gets no platform key", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed(); // no owner seeded
    const gw = await cx.startGateway({
      env: platformEnv,
      expectedEdition: "Cloud",
    });

    await throughProxy(gw.origin, {
      url: upstream.url("/v1/messages"),
      token: cx.ids.agentToken,
    });

    const [seen] = await upstream.waitForRequests(1);
    expect(seen?.header("x-api-key")).toBeUndefined();
  });
});
