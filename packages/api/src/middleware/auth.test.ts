import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ApiEnv } from "../types";

// The auth middleware bridges scope carried in the query string
// (_token/_project/_org) into the request headers so browser navigations that
// can't set headers — the app-connect → GET /v1/apps/:provider/authorize
// redirect — still resolve the right project. The regression these guard: on
// onprem-slim the session is ambient (no _token JWT), so before the fix the
// _project param was ignored and the authorize fell back to the user's default
// project. Pin to onprem-slim so CAPS.tenancy is single-org-shared (header-less
// requests fall back to the default project) and CAPS.rbac is off.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem-slim";
});

const USER = "user-1";
const ORG = "org-1";
const TARGET_PROJECT = "proj-target";
const DEFAULT_PROJECT = "proj-default";

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: { findUnique: async () => null },
    user: {
      findUnique: async ({ select }: { select?: Record<string, unknown> }) =>
        select?.organizationMemberships
          ? { organizationMemberships: [{ organizationId: ORG }] }
          : { id: USER, email: "admin@localhost" },
    },
    organizationMember: {
      findFirst: async () => ({ organizationId: ORG }),
    },
    project: {
      // Header path (resolveProjectId) queries by id; the default-project
      // fallback (findUserDefaultProject) queries by createdByUserId.
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where?.id
          ? { id: where.id, organizationId: ORG, createdByUserId: USER }
          : { id: DEFAULT_PROJECT, organizationId: ORG },
      findUnique: async () => ({ organizationId: ORG }),
    },
  },
}));

import { auth } from "./auth";
import { initSession } from "../providers/session";

const makeApp = () => {
  const app = new Hono<ApiEnv>();
  app.get("/echo", auth({ requireProject: false }), (c) =>
    c.json({ projectId: c.get("auth").projectId }),
  );
  return app;
};

describe("auth middleware — scope query-param bridge", () => {
  describe("ambient session (onprem-slim local auth, no _token)", () => {
    // Mirrors the local-auth session provider: authenticated regardless of the
    // request (it reads the ambient Next.js session, not the passed request).
    beforeEach(() =>
      initSession({
        getSession: async () => ({
          id: "local-admin",
          email: "admin@localhost",
        }),
      }),
    );

    it("bridges ?_project into the project scope", async () => {
      const res = await makeApp().request(`/echo?_project=${TARGET_PROJECT}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ projectId: TARGET_PROJECT });
    });

    it("falls back to the default project without ?_project", async () => {
      const res = await makeApp().request("/echo");
      expect(await res.json()).toEqual({ projectId: DEFAULT_PROJECT });
    });

    it("does not let ?_project override a real x-project-id header", async () => {
      const res = await makeApp().request("/echo?_project=proj-evil", {
        headers: { "x-project-id": TARGET_PROJECT },
      });
      expect(await res.json()).toEqual({ projectId: TARGET_PROJECT });
    });

    it("degrades a malformed scope param to the default (no 500)", async () => {
      // A non-Latin1 value (emoji, %F0%9F%98%80) makes Headers.set throw; the
      // bridge must swallow it and authenticate as if the param were absent,
      // not surface a 500.
      const res = await makeApp().request("/echo?_project=%F0%9F%98%80");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ projectId: DEFAULT_PROJECT });
    });
  });

  describe("query-token session (cloud browser navigation)", () => {
    // Mirrors a header-reading (JWT) provider: authenticated only when the
    // bridged Authorization is present — proving _token → Authorization works.
    beforeEach(() =>
      initSession({
        getSession: async (req) =>
          req.headers.get("authorization") === "Bearer jwt-123"
            ? { id: "cloud-user", email: "u@example.com" }
            : null,
      }),
    );

    it("bridges ?_token into Authorization and ?_project into the scope", async () => {
      const res = await makeApp().request(
        `/echo?_token=jwt-123&_project=${TARGET_PROJECT}`,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ projectId: TARGET_PROJECT });
    });

    it("rejects when no _token and no session", async () => {
      const res = await makeApp().request(`/echo?_project=${TARGET_PROJECT}`);
      expect(res.status).toBe(401);
    });
  });
});
