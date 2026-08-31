import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../types";

/**
 * GET /v1/org — the current-org read the create door rides.
 *
 * Three properties: the response carries exactly the org object plus the
 * creation-world column (`byoLegacy`, §3.10 re-decided 2026-08-23) and nothing
 * else; the org is resolved from the membership-fenced auth context, never
 * from input; and the `role: "member"` fence re-checks an API key's user
 * still holds an ACTIVE membership — a departed member's key reads nothing.
 */

const ORG = "org-1";
const ORG_KEY = "oc_org_test-key";

// Pinned onprem: CAPS.rbac off, so the org-key auth needs no role resolver and
// the member fence is the flat-team active-membership check.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

const state = vi.hoisted(() => ({
  membershipActive: true,
  orgQueries: [] as { id?: string }[],
}));

vi.mock("@onecli/db", () => ({
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key?: string } }) =>
        where.key === ORG_KEY
          ? { userId: "user-1", organizationId: ORG, scope: "organization" }
          : null,
    },
    user: {
      findUnique: async () => ({ id: "user-1", email: "admin@example.com" }),
    },
    organizationMember: {
      findFirst: async () =>
        state.membershipActive ? { userId: "user-1" } : null,
    },
    organization: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        state.orgQueries.push(where);
        return where.id === ORG
          ? {
              id: ORG,
              name: "Acme",
              slug: "acme",
              byoLegacy: true,
              byoEnabled: false,
            }
          : null;
      },
    },
  },
}));

let app: Hono<ApiEnv>;

beforeAll(async () => {
  const { createApiApp } = await import("../app");
  app = createApiApp({ getSession: async () => null });
});

beforeEach(() => {
  state.membershipActive = true;
  state.orgQueries = [];
});

const authed = { headers: { Authorization: `Bearer ${ORG_KEY}` } };

describe("GET /v1/org", () => {
  it("returns the org with EXACTLY the org object + the creation world", async () => {
    const res = await app.request("/v1/org", authed);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The exact-key pin (the instance.test.ts convention): a new field must
    // be added here deliberately, and a leaked column fails loudly.
    expect(Object.keys(body).sort()).toEqual([
      "byoEnabled",
      "byoLegacy",
      "id",
      "name",
      "slug",
    ]);
    expect(body).toEqual({
      id: ORG,
      name: "Acme",
      slug: "acme",
      byoLegacy: true,
      byoEnabled: false,
    });
  });

  it("resolves the org from the KEY's auth context, never from input", async () => {
    // A crafted header must not steer the read — the query's id is the key
    // row's org, by construction.
    await app.request("/v1/org", {
      headers: { ...authed.headers, "x-organization-id": "org-evil" },
    });
    expect(state.orgQueries).toEqual([{ id: ORG }]);
  });

  it("401s an anonymous caller", async () => {
    const res = await app.request("/v1/org");
    expect(res.status).toBe(401);
  });

  it("403s a departed member's still-live API key (the member fence)", async () => {
    state.membershipActive = false;
    const res = await app.request("/v1/org", authed);
    expect(res.status).toBe(403);
    // And the org row was never read.
    expect(state.orgQueries).toEqual([]);
  });
});
