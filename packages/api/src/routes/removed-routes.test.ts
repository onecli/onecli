import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../types";

// The paths step 10 removed must answer 410 Gone with a pointer, not the
// router's generic 404 — `/v1` is a versioned public surface and `onecli rules`
// is in the wild. Two properties, and the second is the one that can silently
// break: these shims mount on base paths that STILL HAVE live routes
// (`/agents`, `/connections`), so a too-greedy pattern would turn a working
// endpoint into a 410. Every removed path below is paired with a live sibling.
//
// Authenticated with an org key + X-Project-Id (the onprem-slim shape, so no
// role resolver is needed), because the live routers' auth middleware runs
// before a shim on the same base path — an anonymous caller gets 401, which is
// correct but would not exercise the shims.

const ORG = "org-1";
const PROJECT = "proj-1";
const ORG_KEY = "oc_org_test-key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem-slim";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key?: string } }) =>
        where.key === ORG_KEY
          ? { userId: "user-1", organizationId: ORG, scope: "organization" }
          : null,
      findFirst: async () => null,
      findMany: async () => [],
    },
    user: {
      findUnique: async ({ select }: { select?: Record<string, unknown> }) =>
        select?.organizationMemberships
          ? { organizationMemberships: [{ organizationId: ORG }] }
          : { id: "user-1", email: "admin@example.com" },
    },
    organizationMember: {
      findFirst: async () => ({ organizationId: ORG }),
      findUnique: async () => ({ organizationId: ORG, role: "admin" }),
    },
    project: {
      findFirst: async ({ where }: { where?: { id?: string } }) =>
        where?.id
          ? where.id === PROJECT
            ? { id: where.id, organizationId: ORG, createdByUserId: "user-1" }
            : null
          : { id: PROJECT, organizationId: ORG },
      findUnique: async () => ({ organizationId: ORG }),
    },
    agent: { findMany: async () => [], findFirst: async () => null },
    appConnection: { findMany: async () => [], findFirst: async () => null },
    secret: { findMany: async () => [] },
    policyRuleV2: {
      findMany: async () => [],
      aggregate: async () => ({ _max: { generation: null } }),
    },
    auditLog: { create: async () => ({}) },
  },
}));

let app: Hono<ApiEnv>;

beforeAll(async () => {
  const { createApiApp } = await import("../app");
  app = createApiApp({ getSession: async () => null });
});

const authed = {
  headers: { Authorization: `Bearer ${ORG_KEY}`, "x-project-id": PROJECT },
};

const status = async (method: string, path: string): Promise<number> =>
  (await app.request(path, { method, ...authed })).status;

describe("removed old-model endpoints answer 410, not 404", () => {
  it.each([
    ["GET", "/v1/rules"],
    ["POST", "/v1/rules"],
    ["GET", "/v1/rules/some-rule-id"],
    ["PATCH", "/v1/rules/some-rule-id"],
    ["DELETE", "/v1/rules/some-rule-id"],
    ["GET", "/v1/rules/overlap/github"],
    ["PUT", "/v1/rules/permissions/github"],
    ["GET", "/v1/agents/granular-access"],
    ["GET", "/v1/agents/agent-1/secrets"],
    ["PUT", "/v1/agents/agent-1/secrets"],
    ["GET", "/v1/agents/agent-1/connections"],
    ["PUT", "/v1/agents/agent-1/connections"],
    // Attach-model step 5: the mode switch is gone — agents are always
    // selective. The CLI's `onecli agents set-secret-mode` lands here.
    ["PATCH", "/v1/agents/agent-1/secret-mode"],
    ["GET", "/v1/connections/conn-1/agents"],
    ["PUT", "/v1/connections/conn-1/agents"],
    // Attach-model step 6: project-scope policy CRUD retired. Enumerated, not
    // wildcarded — the reflection on the same base path must stay live (see
    // the "is not 410" table below).
    ["GET", "/v1/policy/rules"],
    ["POST", "/v1/policy/rules"],
    ["PUT", "/v1/policy/rules/order"],
    ["PATCH", "/v1/policy/rules/rule-1"],
    ["DELETE", "/v1/policy/rules/rule-1"],
    ["GET", "/v1/policy/default"],
    ["PATCH", "/v1/policy/default"],
    ["POST", "/v1/policy/publish"],
    ["GET", "/v1/policy/last-publish"],
  ])("%s %s → 410", async (method, path) => {
    expect(await status(method, path)).toBe(410);
  });

  it("every 410 body names the replacement, so a client can act on it", async () => {
    // Project-scope shims point at the GRANTS surface. Pointing them at
    // /v1/policy (as they did before step 6) would send a project client to
    // another 410 — that path is retired at project scope now.
    for (const path of [
      "/v1/rules",
      "/v1/agents/agent-1/secrets",
      "/v1/connections/conn-1/agents",
      "/v1/policy/rules",
      "/v1/policy/publish",
    ]) {
      const text = await (await app.request(path, authed)).text();
      expect(text).toContain("/grants/");
      expect(text).not.toContain("Use /v1/policy");
    }
    const text = await (
      await app.request("/v1/agents/agent-1/secret-mode", {
        method: "PATCH",
        ...authed,
      })
    ).text();
    expect(text).toContain("/grants/");
  });
});

describe("the shims stay scoped to the paths they replace", () => {
  // Hono ranks a specific route above a wildcard regardless of mount order, so
  // a live sibling can't be shadowed however greedy a shim gets — asserting
  // that would pass unconditionally and prove nothing. What a `/*` shim WOULD
  // break is everything else under the same base: an unknown path stops being
  // a 404 and starts claiming it used to exist and was removed. That is the
  // assertion with teeth, and it fails if any shim is widened to a catch-all.
  it.each([
    ["/v1/agents/no-such-endpoint"],
    ["/v1/agents/agent-1/no-such-endpoint"],
    ["/v1/connections/conn-1/no-such-endpoint"],
    ["/v1/rules-adjacent"],
  ])("%s is a plain 404, never a 410", async (path) => {
    expect(await status("GET", path)).toBe(404);
  });

  // The live siblings still answer — cheap regression cover for the mount.
  it.each([
    ["/v1/agents", "the agents list"],
    ["/v1/agents/agent-1/effective-credentials", "the credential reflection"],
    ["/v1/connections", "the connections list"],
    // The reflection shares the /v1/policy base with the step-6 shim; if that
    // shim ever grows a wildcard this is the assertion that catches it.
    [
      "/v1/policy/effective-app-permissions?provider=github",
      "the app-permissions reflection",
    ],
  ])("%s (%s) is not 410", async (path) => {
    expect(await status("GET", path)).not.toBe(410);
  });
});
