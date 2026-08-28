import { describe, expect } from "vitest";

import { scenario } from "../src/scenario.js";
import { throughProxy } from "../src/proxy.js";

/**
 * The platform Anthropic trial credit (`ee/platform_llm.rs`), black-box.
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
 *    same user shares the exhausted pool (the "new org, fresh $5" hole).
 */

const PLATFORM_KEY = "sk-ant-api03-platform-e2e";

const platformEnv = {
  PLATFORM_ANTHROPIC_API_KEY: PLATFORM_KEY,
  // The e2e upstreams live on 127.0.0.1; production leaves this unset.
  PLATFORM_ANTHROPIC_API_HOST: "127.0.0.1",
} as const;

describe("platform trial credit", () => {
  scenario("injects the platform key for a keyless org", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed(); // no secrets, no grants — a brand-new user's world
    const gw = await cx.startGateway({ env: platformEnv });

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
    const gw = await cx.startGateway(); // no PLATFORM_ANTHROPIC_API_KEY

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
      const gw = await cx.startGateway({
        env: { PLATFORM_ANTHROPIC_API_KEY: PLATFORM_KEY },
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
      const gw = await cx.startGateway({ env: platformEnv });

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
      // Spend the whole credit via the durable floor — the same row a running
      // gateway persists and a restarted one rehydrates enforcement from. No
      // owner is seeded, so the grant subject falls back to the ORG-attributed
      // subject (`org:<id>` — the column carries a rendered BudgetSubject,
      // never a bare id).
      await cx.db.prisma.budgetSpend.create({
        data: {
          secretId: "platform:anthropic",
          organizationId: `org:${cx.ids.org}`,
          period: "total",
          // $5 in nano-dollars — exactly the default limit, and >= is a block.
          spentNanos: 5_000_000_000n,
        },
      });
      const gw = await cx.startGateway({ env: platformEnv });

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
      const email = `${cx.ids.nonce}-owner@e2e.invalid`;
      await cx.db.prisma.user.create({
        data: { id: cx.ids.user, email, externalAuthId: cx.ids.user },
      });
      await cx.db.prisma.organizationMember.create({
        data: {
          organizationId: cx.ids.org,
          userId: cx.ids.user,
          userEmail: email,
          role: "owner",
        },
      });
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
      const gw = await cx.startGateway({ env: platformEnv });

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
});
