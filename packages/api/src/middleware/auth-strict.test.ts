import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ApiEnv } from "../types";

// Strict API-key mode (EE): an `oc_` bearer commits to API-key auth instead of
// falling through to session auth. The regression these guard: on onprem the
// session is ambient (local admin), so an org key that failed key auth — e.g.
// no X-Project-Id header — silently resolved to the user's DEFAULT project.
// Pin onprem-slim so the ambient-session fallthrough is actually reachable
// (and CAPS.rbac is off, so the org-key role re-check is skipped).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem-slim";
});

const USER = "user-1";
const ORG = "org-1";
const TARGET_PROJECT = "proj-target";
const DEFAULT_PROJECT = "proj-default";
const ORG_KEY = "oc_org_valid-key";

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key?: string } }) =>
        where.key === ORG_KEY
          ? { userId: USER, organizationId: ORG, scope: "organization" }
          : null,
    },
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
      // Org-key path verifies the header project belongs to the key's org
      // (findFirst by id+org); the ambient default fallback queries without id.
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where?.id
          ? where.id === TARGET_PROJECT
            ? { id: where.id, organizationId: ORG, createdByUserId: USER }
            : null
          : { id: DEFAULT_PROJECT, organizationId: ORG },
      findUnique: async () => ({ organizationId: ORG }),
    },
  },
}));

import { auth } from "./auth";
import { initSession, initStrictApiKeyAuth } from "../providers";

const makeApp = () => {
  const app = new Hono<ApiEnv>();
  app.get("/scoped", auth(), (c) =>
    c.json({ projectId: c.get("auth").projectId }),
  );
  app.get("/org-level", auth({ requireProject: false }), (c) =>
    c.json({ projectId: c.get("auth").projectId ?? null }),
  );
  return app;
};

const bearer = (token: string) => ({
  headers: { authorization: `Bearer ${token}` },
});

describe("auth middleware — strict API-key mode", () => {
  beforeEach(() => {
    // Ambient local session, like onprem's local auth: authenticated
    // regardless of the request.
    initSession({
      getSession: async () => ({ id: "local-admin", email: "admin@localhost" }),
    });
    initStrictApiKeyAuth(false);
  });

  describe("strict ON (EE editions)", () => {
    beforeEach(() => initStrictApiKeyAuth(true));

    it("org key without X-Project-Id → 401 naming the header", async () => {
      const res = await makeApp().request("/scoped", bearer(ORG_KEY));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.message).toBe("X-Project-Id header is required");
    });

    it("unknown oc_ key → 401 generic (never the header hint)", async () => {
      const res = await makeApp().request("/scoped", bearer("oc_org_revoked"));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.message).toBe("Invalid API key or token.");
    });

    it("org key with a valid X-Project-Id resolves that project", async () => {
      const res = await makeApp().request("/scoped", {
        headers: {
          authorization: `Bearer ${ORG_KEY}`,
          "x-project-id": TARGET_PROJECT,
        },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ projectId: TARGET_PROJECT });
    });

    it("org key with a project outside the org → 401", async () => {
      const res = await makeApp().request("/scoped", {
        headers: {
          authorization: `Bearer ${ORG_KEY}`,
          "x-project-id": "proj-other-org",
        },
      });
      expect(res.status).toBe(401);
    });

    it("org key on a requireProject:false route succeeds without a header", async () => {
      const res = await makeApp().request("/org-level", bearer(ORG_KEY));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ projectId: null });
    });

    it("no bearer at all → ambient session still works", async () => {
      const res = await makeApp().request("/scoped");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ projectId: DEFAULT_PROJECT });
    });

    it("a non-oc_ bearer still falls through to session auth", async () => {
      const res = await makeApp().request("/scoped", bearer("some-jwt"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ projectId: DEFAULT_PROJECT });
    });
  });

  describe("strict OFF (OSS default) — fallthrough preserved", () => {
    it("org key without X-Project-Id falls through to the ambient session", async () => {
      const res = await makeApp().request("/scoped", bearer(ORG_KEY));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ projectId: DEFAULT_PROJECT });
    });

    it("unknown oc_ key falls through to the ambient session", async () => {
      const res = await makeApp().request("/scoped", bearer("oc_bogus"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ projectId: DEFAULT_PROJECT });
    });
  });
});
