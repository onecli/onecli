import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../types";

/**
 * Route-level tests for the agent-facing activity API (#411).
 *
 * Two things this surface must get right, both asserted here:
 *
 * 1. **It is the dashboard's data, not a way around it** — every read is
 *    project-scoped and carries the caller as the `viewer`, so the org-rule
 *    redaction the Activity page applies also applies here. The service owns
 *    that logic; these tests pin that the route actually hands it the viewer.
 * 2. **Bad input fails loudly** — an automation polling for "did my call land?"
 *    must never read a silently-ignored filter as "no such event".
 */

const PROJECT_KEY = "oc_activity_test_key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem-slim";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
});

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === PROJECT_KEY
          ? { userId: "user-1", projectId: "proj-1" }
          : null,
    },
    project: {
      findUnique: async () => ({ id: "proj-1", organizationId: "org-1" }),
    },
    user: { findUnique: async () => ({ email: "dev@example.com" }) },
  },
}));

// Capture what the route asks the service for — the assertions below are about
// the arguments (scope, viewer, parsed filters), not about Prisma.
const calls = vi.hoisted(() => ({
  list: [] as unknown[][],
  byId: [] as unknown[][],
}));

vi.mock("../services/request-log-service", () => ({
  getRequestLogs: vi.fn(async (...args: unknown[]) => {
    calls.list.push(args);
    return { logs: [], nextCursor: null };
  }),
  getRequestLogById: vi.fn(async (...args: unknown[]) => {
    calls.byId.push(args);
    const [, id] = args as [string, string];
    return id === "known" ? { id: "known", host: "api.github.com" } : null;
  }),
}));

import { createApiApp } from "../app";

const app: Hono<ApiEnv> = createApiApp({ getSession: async () => null });
const headers = { authorization: `Bearer ${PROJECT_KEY}` };

const get = (url: string) => app.request(url, { headers });

beforeEach(() => {
  calls.list.length = 0;
  calls.byId.length = 0;
});

describe("GET /v1/activity", () => {
  it("requires authentication", async () => {
    const res = await app.request("/v1/activity");
    expect(res.status).toBe(401);
  });

  it("returns a page and scopes it to the caller's project", async () => {
    const res = await get("/v1/activity");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ logs: [], nextCursor: null });
    expect(calls.list[0]?.[0]).toBe("proj-1");
  });

  // The load-bearing one: without the viewer the service fails safe to
  // redaction, but an admin would then never see org rules here — and a future
  // refactor that passes a WRONG viewer would silently widen visibility.
  it("passes the caller as the viewer so org-rule redaction applies", async () => {
    await get("/v1/activity");

    expect(calls.list[0]?.[2]).toEqual({
      userId: "user-1",
      organizationId: "org-1",
    });
  });

  it("threads the automation filters through to the service", async () => {
    await get(
      "/v1/activity?agentId=agent-1&host=api.github.com&provider=github" +
        "&method=post&status=403&since=2026-07-01T00:00:00Z" +
        "&until=2026-07-02T00:00:00Z&filter=blocked&limit=10",
    );

    const params = calls.list[0]?.[1] as {
      filter?: string;
      limit?: number;
      query?: Record<string, unknown>;
    };

    expect(params.filter).toBe("blocked");
    expect(params.limit).toBe(10);
    expect(params.query).toEqual({
      agentId: "agent-1",
      host: "api.github.com",
      provider: "github",
      method: "post",
      status: 403,
      since: new Date("2026-07-01T00:00:00Z"),
      until: new Date("2026-07-02T00:00:00Z"),
    });
  });

  it("forwards a complete keyset cursor", async () => {
    await get(
      "/v1/activity?cursorCreatedAt=2026-07-01T00:00:00Z&cursorId=log-9",
    );

    const params = calls.list[0]?.[1] as {
      cursor?: { createdAt: string; id: string };
    };
    expect(params.cursor).toEqual({
      createdAt: "2026-07-01T00:00:00Z",
      id: "log-9",
    });
  });

  // A half-cursor silently restarting at page one is how a paging automation
  // loops forever on the first page instead of finishing.
  it("rejects a half-supplied cursor rather than restarting at page one", async () => {
    const res = await get("/v1/activity?cursorCreatedAt=2026-07-01T00:00:00Z");

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("cursorCreatedAt and cursorId");
    expect(calls.list).toHaveLength(0);
  });

  it("rejects an unparseable timestamp instead of dropping the bound", async () => {
    const res = await get("/v1/activity?since=last-tuesday");

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("since");
    expect(calls.list).toHaveLength(0);
  });

  it("rejects an inverted time window", async () => {
    const res = await get(
      "/v1/activity?since=2026-07-02T00:00:00Z&until=2026-07-01T00:00:00Z",
    );

    expect(res.status).toBe(400);
    expect(calls.list).toHaveLength(0);
  });

  it("rejects an out-of-range limit and an unknown filter", async () => {
    expect((await get("/v1/activity?limit=5000")).status).toBe(400);
    expect((await get("/v1/activity?limit=0")).status).toBe(400);
    expect((await get("/v1/activity?filter=everything")).status).toBe(400);
    expect(calls.list).toHaveLength(0);
  });
});

describe("GET /v1/activity/:id", () => {
  it("returns the event, scoped to the caller's project", async () => {
    const res = await get("/v1/activity/known");

    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("known");
    expect(calls.byId[0]?.[0]).toBe("proj-1");
    expect(calls.byId[0]?.[2]).toEqual({
      userId: "user-1",
      organizationId: "org-1",
    });
  });

  it("404s for an unknown or foreign id", async () => {
    const res = await get("/v1/activity/nope");
    expect(res.status).toBe(404);
  });

  it("requires authentication", async () => {
    expect((await app.request("/v1/activity/known")).status).toBe(401);
  });
});
