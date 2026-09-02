import { describe, expect } from "vitest";

import { throughProxy } from "../src/proxy.js";
import { scenario, type Cx } from "../src/scenario.js";

const SECRET = "sk-e2e-injected-value";

describe("credential injection", () => {
  scenario(
    "injects the configured header into the upstream request",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed({
        grantAll: true,
        secrets: [
          { hostPattern: "127.0.0.1", headerName: "x-test-key", value: SECRET },
        ],
      });
      const gw = await cx.startGateway();

      const res = await throughProxy(gw.origin, {
        url: upstream.url("/v1/models"),
        token: cx.ids.agentToken,
      });

      expect(res.status).toBe(200);
      const [seen] = await upstream.waitForRequests(1);
      // The whole product in one assertion: a credential the client never had
      // arrived at the upstream, decrypted from a real stored ciphertext.
      expect(seen?.header("x-test-key")).toBe(SECRET);
    },
  );

  scenario("applies valueFormat when injecting", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({
      grantAll: true,
      secrets: [
        {
          hostPattern: "127.0.0.1",
          headerName: "authorization",
          value: SECRET,
          valueFormat: "Bearer {value}",
        },
      ],
    });
    const gw = await cx.startGateway();

    await throughProxy(gw.origin, {
      url: upstream.url("/v1/models"),
      token: cx.ids.agentToken,
    });

    const [seen] = await upstream.waitForRequests(1);
    expect(seen?.header("authorization")).toBe(`Bearer ${SECRET}`);
  });

  scenario(
    "does not leak the agent's proxy credential upstream",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed();
      const gw = await cx.startGateway();

      await throughProxy(gw.origin, {
        url: upstream.url("/v1/models"),
        token: cx.ids.agentToken,
      });

      const [seen] = await upstream.waitForRequests(1);
      expect(seen?.header("proxy-authorization")).toBeUndefined();
      expect(JSON.stringify(seen?.headers)).not.toContain(cx.ids.agentToken);
    },
  );

  scenario(
    "does not inject on a host the secret is not scoped to",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed({
        grantAll: true,
        // Scoped to a host this request will never reach.
        secrets: [
          {
            hostPattern: "api.example.invalid",
            headerName: "x-test-key",
            value: SECRET,
          },
        ],
      });
      const gw = await cx.startGateway();

      await throughProxy(gw.origin, {
        url: upstream.url("/v1/models"),
        token: cx.ids.agentToken,
      });

      const [seen] = await upstream.waitForRequests(1);
      expect(seen?.header("x-test-key")).toBeUndefined();
    },
  );
});

/**
 * A secret's `pathPattern` narrows where its credential is allowed to go.
 *
 * `/v1/*` and `/v1*` are genuinely different — the first is boundary-aware and
 * the second is a bare prefix — and getting that backwards leaks a credential
 * onto neighbouring paths without failing anything else.
 */
describe("injection path scoping", () => {
  const scoped = (pathPattern?: string) => ({
    grantAll: true,
    secrets: [
      {
        hostPattern: "127.0.0.1",
        headerName: "x-test-key",
        value: SECRET,
        pathPattern,
      },
    ],
  });

  const injectedAt = async (
    cx: Cx,
    pathPattern: string | undefined,
    path: string,
  ): Promise<string | undefined> => {
    const upstream = await cx.upstream();
    await cx.seed(scoped(pathPattern));
    const gw = await cx.startGateway();
    await throughProxy(gw.origin, {
      url: upstream.url(path),
      token: cx.ids.agentToken,
    });
    const [seen] = await upstream.waitForRequests(1);
    return seen?.header("x-test-key");
  };

  scenario("injects on a path inside the pattern", async (cx) => {
    expect(await injectedAt(cx, "/v1/*", "/v1/models")).toBe(SECRET);
  });

  scenario("injects on the pattern's own prefix", async (cx) => {
    // `/v1/*` matches bare `/v1` too, not only its children.
    expect(await injectedAt(cx, "/v1/*", "/v1")).toBe(SECRET);
  });

  scenario("respects the segment boundary of a `/*` pattern", async (cx) => {
    // `/v1beta` is NOT inside `/v1/*` — the slash is required.
    expect(await injectedAt(cx, "/v1/*", "/v1beta/models")).toBeUndefined();
  });

  scenario("treats a bare `*` suffix as a plain prefix", async (cx) => {
    // The same request as above, one character different in the pattern, and
    // now it matches. This pair is the whole point.
    expect(await injectedAt(cx, "/v1*", "/v1beta/models")).toBe(SECRET);
  });

  scenario("matches against the path without its query", async (cx) => {
    expect(await injectedAt(cx, "/v1/models", "/v1/models?limit=5")).toBe(
      SECRET,
    );
  });

  scenario("defaults to every path when unset", async (cx) => {
    expect(await injectedAt(cx, undefined, "/anywhere/at/all")).toBe(SECRET);
  });
});

describe("injection shapes", () => {
  scenario("swaps authorization for an Anthropic API key", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({
      grantAll: true,
      secrets: [{ type: "anthropic", hostPattern: "127.0.0.1", value: SECRET }],
    });
    const gw = await cx.startGateway();

    await throughProxy(gw.origin, {
      url: upstream.url("/v1/messages"),
      token: cx.ids.agentToken,
      headers: { authorization: "Bearer client-supplied-token" },
    });

    const [seen] = await upstream.waitForRequests(1);
    expect(seen?.header("x-api-key")).toBe(SECRET);
    // The removal is the half that matters and the only place anywhere in the
    // gateway that deletes a client header. Leaving the client's own
    // authorization in place makes Anthropic reject the request outright.
    expect(seen?.header("authorization")).toBeUndefined();
  });

  scenario("injects a credential into a query parameter", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({
      grantAll: true,
      secrets: [
        { hostPattern: "127.0.0.1", paramName: "api_key", value: SECRET },
      ],
    });
    const gw = await cx.startGateway();

    await throughProxy(gw.origin, {
      url: upstream.url("/v1/models?limit=5"),
      token: cx.ids.agentToken,
    });

    const [seen] = await upstream.waitForRequests(1);
    expect(seen?.url).toContain(`api_key=${SECRET}`);
    // The existing query must survive alongside it.
    expect(seen?.url).toContain("limit=5");
  });

  scenario("rewrites the request path from a template", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({
      grantAll: true,
      secrets: [
        {
          hostPattern: "127.0.0.1",
          pathTemplate: "/bot{value}",
          value: SECRET,
        },
      ],
    });
    const gw = await cx.startGateway();

    // The agent sends a placeholder where the credential belongs; the gateway
    // repairs it, so the agent never holds the token.
    await throughProxy(gw.origin, {
      url: upstream.url("/botPLACEHOLDER/sendMessage"),
      token: cx.ids.agentToken,
    });

    const [seen] = await upstream.waitForRequests(1);
    // Asserting on the URL the upstream saw is what makes this strong: a
    // regression here puts the credential somewhere the agent can read back.
    expect(seen?.url).toBe(`/bot${SECRET}/sendMessage`);
  });

  scenario("rewrites the request path by regex", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({
      grantAll: true,
      secrets: [
        {
          hostPattern: "127.0.0.1",
          pathRegex: "^/proj/[^/]+/",
          pathReplacement: "/proj/{value}/",
          value: SECRET,
        },
      ],
    });
    const gw = await cx.startGateway();

    await throughProxy(gw.origin, {
      url: upstream.url("/proj/PLACEHOLDER/items"),
      token: cx.ids.agentToken,
    });

    const [seen] = await upstream.waitForRequests(1);
    // Both halves are required by the injector; supplying only one silently
    // yields no injection at all, which would leave the placeholder in place.
    expect(seen?.url).toBe(`/proj/${SECRET}/items`);
  });
});

/**
 * Org-scoped secrets are a tenancy boundary, not a convenience.
 *
 * The `scope = 'organization'` predicate exists in exactly one SQL string
 * (`db.rs:333`); deleting it is a one-character change that compiles and breaks
 * no other test.
 */
describe("secret scope", () => {
  scenario("injects an organization-scoped secret", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({
      grantAll: true,
      secrets: [
        {
          scope: "organization",
          hostPattern: "127.0.0.1",
          headerName: "x-test-key",
          value: SECRET,
        },
      ],
    });
    const gw = await cx.startGateway();

    await throughProxy(gw.origin, {
      url: upstream.url("/v1/models"),
      token: cx.ids.agentToken,
    });

    const [seen] = await upstream.waitForRequests(1);
    expect(seen?.header("x-test-key")).toBe(SECRET);
  });

  scenario("lets the workspace secret win over the org one", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({
      grantAll: true,
      secrets: [
        {
          scope: "organization",
          hostPattern: "127.0.0.1",
          headerName: "x-test-key",
          value: "org-level-value",
        },
        {
          hostPattern: "127.0.0.1",
          headerName: "x-test-key",
          value: SECRET,
        },
      ],
    });
    const gw = await cx.startGateway();

    await throughProxy(gw.origin, {
      url: upstream.url("/v1/models"),
      token: cx.ids.agentToken,
    });

    const [seen] = await upstream.waitForRequests(1);
    // Both target the same header. Org first, workspace second, last write wins
    // — so the more specific level overrides the broader one.
    expect(seen?.header("x-test-key")).toBe(SECRET);
  });
});
