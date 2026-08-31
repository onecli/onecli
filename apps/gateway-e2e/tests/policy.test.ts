import { describe, expect } from "vitest";

import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/** One world shared by the block/allow pair, so they visibly test one rule. */
const BLOCK_WORLD = {
  rules: [
    {
      name: "block-secrets-path",
      action: "block" as const,
      targets: [{ hostPattern: "127.0.0.1", pathPattern: "/blocked*" }],
    },
  ],
};

describe("policy enforcement", () => {
  scenario("blocks a matching request before any egress", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed(BLOCK_WORLD);
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: upstream.url("/blocked/thing"),
      token: cx.ids.agentToken,
    });

    expect(res.status).toBe(403);
    expect(res.header("x-should-retry")).toBe("false");
    expect(res.json()).toMatchObject({
      error: "blocked_by_policy",
      rule_name: "block-secrets-path",
    });
    // The assertion that actually matters. A gateway that forwards and *then*
    // returns 403 would satisfy every check above while leaking the request.
    expect(upstream.requests()).toHaveLength(0);
  });

  scenario("allows a request the rule does not match", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed(BLOCK_WORLD);
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: upstream.url("/allowed/thing"),
      token: cx.ids.agentToken,
    });

    expect(res.status).toBe(200);
    await upstream.waitForRequests(1);
  });

  scenario("does not enforce a disabled rule", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({
      rules: [
        {
          name: "switched-off",
          action: "block",
          enabled: false,
          targets: [{ hostPattern: "127.0.0.1" }],
        },
        // Proves rules load at all in this world, so the 200 below can only be
        // the `enabled` filter doing its job.
        {
          name: "narrow-block",
          action: "block",
          targets: [{ hostPattern: "127.0.0.1", pathPattern: "/blocked*" }],
        },
      ],
    });
    const gw = await cx.startGateway();

    const [disabled, firing] = await Promise.all([
      throughProxy(gw.origin, {
        url: upstream.url("/anything"),
        token: cx.ids.agentToken,
      }),
      throughProxy(gw.origin, {
        url: upstream.url("/blocked/thing"),
        token: cx.ids.agentToken,
      }),
    ]);

    // The `enabled` filter lives only in the loader's SQL. Dropping it would
    // silently start enforcing every rule a user had switched off.
    expect(disabled.status).toBe(200);
    expect(firing.status).toBe(403);
  });

  scenario("rate-limits once the allowance is spent", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({
      rules: [
        {
          name: "one-per-hour",
          action: "allow",
          rateLimit: 1,
          // An hour window, not a minute: a minute bucket can roll over
          // mid-test and turn this into a flake.
          rateLimitWindow: "hour",
          targets: [{ hostPattern: "127.0.0.1" }],
        },
      ],
    });
    const gw = await cx.startGateway();

    const first = await throughProxy(gw.origin, {
      url: upstream.url("/v1/models"),
      token: cx.ids.agentToken,
    });
    const second = await throughProxy(gw.origin, {
      url: upstream.url("/v1/models"),
      token: cx.ids.agentToken,
    });

    // The trigger is count > limit, so the first request passes.
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.header("retry-after")).toBeDefined();
    expect(second.json()).toMatchObject({ error: "rate_limited", limit: 1 });
    // Also proves Redis is genuinely wired: the counter lives there, and an
    // unreachable cache fails open rather than limiting.
    expect(upstream.requests()).toHaveLength(1);
  });
});

const SECRET = "sk-e2e-deny-default";

/**
 * The Default Rule is terminal only under the `enforce_deny` carve —
 * `has_injections && !is_llm_host` (`policy_engine/types.rs:106`). The rule
 * itself is identical in both tests; only whether a credential was injected
 * differs, which is the entire carve.
 *
 * Nothing else in the repo covers the wiring: the corpus proves the logic given
 * a `PolicyRequest`, but `has_injections` is populated at `forward.rs:200`, and
 * if that ever went false every Default-Rule Block would stop enforcing while
 * every other test stayed green.
 */
const DEFAULT_DENY_RULE = {
  name: "org-default-deny",
  action: "block" as const,
  isDefault: true,
  // ORG scope (the name always said so; now the row does too). Load-bearing
  // since step 7: the grant that injects the credential is a WORKSPACE allow
  // rule, and only the org default's hard floor survives it — a workspace
  // default would lose first-match to the grant and never fire.
  scope: "organization" as const,
};

describe("deny-by-default", () => {
  scenario("blocks credentialed traffic under the Default Rule", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({
      grantAll: true,
      secrets: [
        { hostPattern: "127.0.0.1", headerName: "x-test-key", value: SECRET },
      ],
      rules: [DEFAULT_DENY_RULE],
    });
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: upstream.url("/v1/models"),
      token: cx.ids.agentToken,
    });

    expect(res.status).toBe(403);
    expect(res.header("x-should-retry")).toBe("false");
    expect(res.json()).toMatchObject({ error: "blocked_by_default_policy" });
    expect(upstream.requests()).toHaveLength(0);
  });

  scenario("lets uncredentialed traffic through the same rule", async (cx) => {
    const upstream = await cx.upstream();
    // Same Default Rule, no secret — so nothing is injected for this host and
    // the carve leaves the block non-terminal.
    await cx.seed({ rules: [DEFAULT_DENY_RULE] });
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: upstream.url("/v1/models"),
      token: cx.ids.agentToken,
    });

    expect(res.status).toBe(200);
    await upstream.waitForRequests(1);
  });
});

/**
 * A `body contains` condition, which only the EE engine evaluates.
 *
 * This pair discriminates three distinct failures at once, which is why both
 * halves are needed: if `needs_body_buffer` (`ee/policy_engine/enforce.rs:37`)
 * stops requesting a buffer the matcher sees `None` and never matches, so the
 * block half fails; if the OSS no-op `condition_match` is compiled in by
 * mistake every condition matches unconditionally, so the allow half fails.
 */
const CONDITION_WORLD = {
  rules: [
    {
      name: "block-on-body",
      action: "block" as const,
      conditions: [
        {
          target: "body" as const,
          operator: "contains" as const,
          value: "wire-transfer",
        },
      ],
      targets: [{ hostPattern: "127.0.0.1" }],
    },
  ],
};

describe("body conditions", () => {
  scenario("blocks when the body carries the condition value", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed(CONDITION_WORLD);
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      method: "POST",
      url: upstream.url("/v1/messages"),
      token: cx.ids.agentToken,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "initiate a WIRE-TRANSFER now" }),
    });

    // The matcher lowercases both sides, so the casing above still matches.
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({
      error: "blocked_by_policy",
      rule_name: "block-on-body",
    });
    expect(upstream.requests()).toHaveLength(0);
  });

  scenario("allows an otherwise identical request without it", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed(CONDITION_WORLD);
    const gw = await cx.startGateway();

    const body = JSON.stringify({ instruction: "summarise the inbox" });
    const res = await throughProxy(gw.origin, {
      method: "POST",
      url: upstream.url("/v1/messages"),
      token: cx.ids.agentToken,
      headers: { "content-type": "application/json" },
      body,
    });

    expect(res.status).toBe(200);
    const [seen] = await upstream.waitForRequests(1);
    // Buffering the body to evaluate the condition must not corrupt it.
    expect(seen?.body).toBe(body);
  });

  // The #999 regression: a body larger than the condition buffer used to be
  // evaluated on its truncated prefix and forwarded when the match text sat
  // past the cap — a fail-open on a policy boundary. The buffer cap is pinned
  // small via its env override so the test doesn't need a 256KB+ body.
  const TRUNCATION_BUFFER = 4096; // the env override's floor
  const truncationEnv = {
    ONECLI_CONDITION_BODY_BUFFER_BYTES: String(TRUNCATION_BUFFER),
  };

  scenario(
    "blocks when the condition value sits past the buffer cap (fail closed)",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed(CONDITION_WORLD);
      const gw = await cx.startGateway({ env: truncationEnv });

      // Padding pushes the match text well past the cap, so the buffered
      // prefix never contains it — the old code forwarded this request.
      const body = JSON.stringify({
        padding: "x".repeat(TRUNCATION_BUFFER * 2),
        instruction: "initiate a wire-transfer now",
      });
      const res = await throughProxy(gw.origin, {
        method: "POST",
        url: upstream.url("/v1/messages"),
        token: cx.ids.agentToken,
        headers: { "content-type": "application/json" },
        body,
      });

      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "block-on-body",
      });
      expect(upstream.requests()).toHaveLength(0);
    },
  );

  scenario(
    "blocks an oversized body even when the value is absent entirely (fail closed)",
    async (cx) => {
      // The strict form of the law: unseen bytes are undecidable, so a
      // restrictive rule matches even though the full body never contained
      // the value. Over-blocking is the accepted cost of never failing open.
      const upstream = await cx.upstream();
      await cx.seed(CONDITION_WORLD);
      const gw = await cx.startGateway({ env: truncationEnv });

      const body = JSON.stringify({
        padding: "x".repeat(TRUNCATION_BUFFER * 2),
        instruction: "summarise the inbox",
      });
      const res = await throughProxy(gw.origin, {
        method: "POST",
        url: upstream.url("/v1/messages"),
        token: cx.ids.agentToken,
        headers: { "content-type": "application/json" },
        body,
      });

      expect(res.status).toBe(403);
      expect(upstream.requests()).toHaveLength(0);
    },
  );

  scenario(
    "an oversized body on a host no body rule matches is not buffered or blocked",
    async (cx) => {
      // The host-narrowing half of #999: the condition rule targets
      // 127.0.0.1, so traffic to another host must skip the buffer entirely
      // and flow untouched, however large the body.
      const upstream = await cx.upstream();
      await cx.seed({
        rules: [
          {
            name: "block-on-body-elsewhere",
            action: "block" as const,
            conditions: [
              {
                target: "body" as const,
                operator: "contains" as const,
                value: "wire-transfer",
              },
            ],
            targets: [{ hostPattern: "unrelated.example.invalid" }],
          },
        ],
      });
      const gw = await cx.startGateway({ env: truncationEnv });

      const body = JSON.stringify({
        padding: "x".repeat(TRUNCATION_BUFFER * 2),
        instruction: "initiate a wire-transfer now",
      });
      const res = await throughProxy(gw.origin, {
        method: "POST",
        url: upstream.url("/v1/messages"),
        token: cx.ids.agentToken,
        headers: { "content-type": "application/json" },
        body,
      });

      expect(res.status).toBe(200);
      const [seen] = await upstream.waitForRequests(1);
      // The un-buffered pass-through must relay the body byte-perfect.
      expect(seen?.body).toBe(body);
    },
  );

  scenario(
    "blocks past the shipped default cap with no env override (the prod path)",
    async (cx) => {
      // The acceptance-shaped run: NO buffer-size override, so this exercises
      // the exact configuration prod ships — a >256KB body (the default cap)
      // whose match text sits past it, the #999 signature at real scale.
      const upstream = await cx.upstream();
      await cx.seed(CONDITION_WORLD);
      const gw = await cx.startGateway();

      const body = JSON.stringify({
        padding: "x".repeat(300 * 1024),
        instruction: "initiate a wire-transfer now",
      });
      const res = await throughProxy(gw.origin, {
        method: "POST",
        url: upstream.url("/v1/messages"),
        token: cx.ids.agentToken,
        headers: { "content-type": "application/json" },
        body,
      });

      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "block-on-body",
      });
      expect(upstream.requests()).toHaveLength(0);
    },
  );

  scenario(
    "matches within the default cap where the old 16KB cap failed open",
    async (cx) => {
      // The differential proof for the issue's observed traffic (~32KB
      // bodies, 2x the old cap): with the value at ~24KB — past the old
      // 16KB cap, within the new 256KB one — the body is now FULLY seen and
      // blocked on a real match, where the pre-fix gateway forwarded it.
      const upstream = await cx.upstream();
      await cx.seed(CONDITION_WORLD);
      const gw = await cx.startGateway();

      const body = JSON.stringify({
        padding: "x".repeat(24 * 1024),
        instruction: "initiate a wire-transfer now",
      });
      const res = await throughProxy(gw.origin, {
        method: "POST",
        url: upstream.url("/v1/messages"),
        token: cx.ids.agentToken,
        headers: { "content-type": "application/json" },
        body,
      });

      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "block-on-body",
      });
      expect(upstream.requests()).toHaveLength(0);
    },
  );
});

describe("rule loading", () => {
  scenario("never enforces an unpublished draft", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({
      rules: [
        {
          name: "draft-block",
          action: "block",
          status: "draft",
          priority: 1,
          targets: [{ hostPattern: "127.0.0.1" }],
        },
        // A published rule at the same generation, deliberately targeting a host
        // this test never calls. Without it the loader's generation subquery
        // returns NULL — no published row to take the max of — and the draft is
        // excluded for that reason instead of the one under test, which makes
        // the assertion below pass even with the status predicate deleted.
        {
          name: "published-decoy",
          action: "allow",
          priority: 2,
          targets: [{ hostPattern: "example.invalid" }],
        },
      ],
    });
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: upstream.url("/anything"),
      token: cx.ids.agentToken,
    });

    // The `status = 'published'` predicate lives only in the loader's SQL.
    // Dropping it would put every half-written draft into force immediately —
    // and the draft here sorts first, so it would win the match.
    expect(res.status).toBe(200);
  });

  scenario("enforces an organization-scoped rule", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({
      rules: [
        {
          name: "org-block",
          action: "block",
          scope: "organization",
          targets: [{ hostPattern: "127.0.0.1" }],
        },
      ],
    });
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: upstream.url("/anything"),
      token: cx.ids.agentToken,
    });

    // Org rules load through their own query, so a workspace-only regression
    // would leave every workspace test green while org policy stopped applying.
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({ rule_name: "org-block" });
    expect(upstream.requests()).toHaveLength(0);
  });

  scenario("holds the org floor over a permissive workspace", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({
      rules: [
        {
          name: "org-block",
          action: "block",
          scope: "organization",
          targets: [{ hostPattern: "127.0.0.1" }],
        },
        {
          name: "workspace-allow",
          action: "allow",
          targets: [{ hostPattern: "127.0.0.1" }],
        },
      ],
    });
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: upstream.url("/anything"),
      token: cx.ids.agentToken,
    });

    // Cross-scope combine is deny-wins: a workspace cannot vote itself out of an
    // org block, however specific its own rule is.
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({ rule_name: "org-block" });
  });

  scenario("takes the first match, not the strictest", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({
      // Declaration order is deliberately the REVERSE of priority order. The
      // fixture assigns ids by declaration index and the engine sorts by
      // (priority, id), so if the priority key were ever dropped the id would
      // decide — and the block, declared first, would win. Listing them in
      // priority order would make all three orderings agree and the assertion
      // below would hold no matter which one was actually used.
      rules: [
        {
          name: "later-block",
          action: "block",
          priority: 2,
          targets: [{ hostPattern: "127.0.0.1" }],
        },
        {
          name: "earlier-allow",
          action: "allow",
          priority: 1,
          targets: [{ hostPattern: "127.0.0.1" }],
        },
      ],
    });
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: upstream.url("/anything"),
      token: cx.ids.agentToken,
    });

    // Both rules match. Within one scope the higher-priority rule shadows the
    // other outright — strictness only arbitrates ACROSS scopes.
    expect(res.status).toBe(200);
  });

  scenario("treats a rule with no targets as inert", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({
      rules: [
        { name: "targetless-block", action: "block" },
        // A rule in the same world that DOES fire. Without it a bare 200 below
        // would also be produced by rules failing to load at all, which is a
        // completely different failure wearing the same result.
        {
          name: "narrow-block",
          action: "block",
          targets: [{ hostPattern: "127.0.0.1", pathPattern: "/blocked*" }],
        },
      ],
    });
    const gw = await cx.startGateway();

    const [inert, firing] = await Promise.all([
      throughProxy(gw.origin, {
        url: upstream.url("/anything"),
        token: cx.ids.agentToken,
      }),
      throughProxy(gw.origin, {
        url: upstream.url("/blocked/thing"),
        token: cx.ids.agentToken,
      }),
    ]);

    // Empty targets on a non-default rule match NOTHING — the fail-closed
    // reading. Flipping it to "any" would turn every orphaned rule (one whose
    // only secret/connection target was deleted) into a total outage.
    expect(inert.status).toBe(200);
    expect(firing.status).toBe(403);
    expect(firing.json()).toMatchObject({ rule_name: "narrow-block" });
  });
});

describe("rule identities", () => {
  scenario("applies a rule bound to the calling agent", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({
      rules: [
        {
          name: "agent-block",
          action: "block",
          identities: ["agent"],
          targets: [{ hostPattern: "127.0.0.1" }],
        },
      ],
    });
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: upstream.url("/anything"),
      token: cx.ids.agentToken,
    });

    expect(res.status).toBe(403);
  });

  scenario("applies an org rule bound to an inherited user", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({
      rules: [
        {
          name: "user-block",
          action: "block",
          scope: "organization",
          identities: ["user"],
          targets: [{ hostPattern: "127.0.0.1" }],
        },
      ],
    });
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: upstream.url("/anything"),
      token: cx.ids.agentToken,
    });

    // The user reaches the agent only via WorkspaceAccess inheritance, so this
    // drives the connect-time principal-set resolution (`find_principal_set`)
    // against a real database — the only automated coverage of that SQL.
    expect(res.status).toBe(403);
  });

  scenario("applies an org rule bound to an inherited group", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({
      rules: [
        {
          name: "group-block",
          action: "block",
          scope: "organization",
          identities: ["group"],
          targets: [{ hostPattern: "127.0.0.1" }],
        },
      ],
    });
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: upstream.url("/anything"),
      token: cx.ids.agentToken,
    });

    // The group reaches the agent via the CTE's granted-group arm
    // (`direct_groups` → `all_groups`), the sibling of the inherited-user
    // path above.
    expect(res.status).toBe(403);
  });

  scenario("ignores a rule bound to a different agent", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({
      rules: [
        {
          name: "other-agent-block",
          action: "block",
          identities: ["other-agent"],
          targets: [{ hostPattern: "127.0.0.1" }],
        },
      ],
    });
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: upstream.url("/anything"),
      token: cx.ids.agentToken,
    });

    // The negative control for the two above: a bound rule that names someone
    // else must not apply, or identity binding is decorative.
    expect(res.status).toBe(200);
  });
});

describe("non-network targets", () => {
  scenario("blocks via a secret-kind target", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({
      secrets: [
        { hostPattern: "127.0.0.1", headerName: "x-test-key", value: SECRET },
      ],
      rules: [
        {
          name: "block-that-secret",
          action: "block",
          targets: [{ kind: "secret", secretIndex: 0 }],
        },
      ],
    });
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: upstream.url("/v1/models"),
      token: cx.ids.agentToken,
    });

    // A secret target carries no host of its own — it resolves to the hosts of
    // the secret it names, which is what keeps "permitted" and "injected" the
    // same set. An unresolved target fails closed and would show up as a 200.
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({ rule_name: "block-that-secret" });
    expect(upstream.requests()).toHaveLength(0);
  });
});
