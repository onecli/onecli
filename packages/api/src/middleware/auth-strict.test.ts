import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ApiEnv } from "../types";

// Strict API-key mode (the default in EVERY edition): an `oc_` bearer commits
// to API-key auth instead of falling through to session auth. The regression
// these guard: with local auth the session is ambient (local admin), so an org
// key that failed key auth — e.g. no X-Workspace-Id header — silently resolved
// to the user's DEFAULT workspace. Pin onprem so the ambient-session fallthrough
// is actually reachable (and CAPS.rbac is off, so the org-key role re-check is
// skipped).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const USER = "user-1";
const ORG = "org-1";
const TARGET_WORKSPACE = "proj-target";
const DEFAULT_WORKSPACE = "proj-default";
const ORG_KEY = "oc_org_valid-key";
// Workspace keys (oc_, not oc_org_). A kind:"user" key authenticates; a
// kind:"service" key (platform-minted, e.g. a channel presence's approvals key)
// must be REJECTED on the general /v1 surface.
const WORKSPACE_USER_KEY = "oc_workspace-user-key";
const WORKSPACE_SERVICE_KEY = "oc_workspace-service-key";

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key?: string } }) => {
        if (where.key === ORG_KEY)
          return { userId: USER, organizationId: ORG, scope: "organization" };
        if (where.key === WORKSPACE_USER_KEY)
          return { userId: USER, workspaceId: TARGET_WORKSPACE, kind: "user" };
        if (where.key === WORKSPACE_SERVICE_KEY)
          return {
            userId: USER,
            workspaceId: TARGET_WORKSPACE,
            kind: "service",
          };
        return null;
      },
    },
    user: {
      findUnique: async ({ select }: { select?: Record<string, unknown> }) =>
        select?.organizationMemberships
          ? { organizationMemberships: [{ organizationId: ORG }] }
          : { id: USER, email: "owner@example.test" },
    },
    organizationMember: {
      findFirst: async () => ({ organizationId: ORG }),
    },
    workspace: {
      // Org-key path verifies the header workspace belongs to the key's org
      // (findFirst by id+org); the ambient default fallback queries without id.
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where?.id
          ? where.id === TARGET_WORKSPACE
            ? { id: where.id, organizationId: ORG, createdByUserId: USER }
            : null
          : { id: DEFAULT_WORKSPACE, organizationId: ORG },
      // Workspace-key path resolves the key's own workspace (id + org).
      findUnique: async () => ({ id: TARGET_WORKSPACE, organizationId: ORG }),
    },
  },
}));

import { auth } from "./auth";
import { initSession, initStrictApiKeyAuth } from "../providers";

const makeApp = () => {
  const app = new Hono<ApiEnv>();
  app.get("/scoped", auth(), (c) =>
    c.json({ workspaceId: c.get("auth").workspaceId }),
  );
  app.get("/org-level", auth({ requireWorkspace: false }), (c) =>
    c.json({ workspaceId: c.get("auth").workspaceId ?? null }),
  );
  return app;
};

const bearer = (token: string) => ({
  headers: { authorization: `Bearer ${token}` },
});

describe("auth middleware — strict API-key mode", () => {
  beforeEach(() => {
    // Ambient local session, like OSS local auth: authenticated
    // regardless of the request.
    initSession({
      getSession: async () => ({
        id: "session-sub-1",
        email: "owner@example.test",
      }),
    });
    initStrictApiKeyAuth(false);
  });

  describe("strict ON (the default in every edition)", () => {
    beforeEach(() => initStrictApiKeyAuth(true));

    it("org key without X-Workspace-Id → 401 naming the header", async () => {
      const res = await makeApp().request("/scoped", bearer(ORG_KEY));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.message).toBe(
        "X-Workspace-Id (formerly X-Project-Id) header is required",
      );
    });

    it("unknown oc_ key → 401 generic (never the header hint)", async () => {
      const res = await makeApp().request("/scoped", bearer("oc_org_revoked"));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.message).toBe("Invalid API key or token.");
    });

    it("org key with a valid X-Workspace-Id resolves that workspace", async () => {
      const res = await makeApp().request("/scoped", {
        headers: {
          authorization: `Bearer ${ORG_KEY}`,
          "x-workspace-id": TARGET_WORKSPACE,
        },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ workspaceId: TARGET_WORKSPACE });
    });

    it("org key with a workspace outside the org → 401", async () => {
      const res = await makeApp().request("/scoped", {
        headers: {
          authorization: `Bearer ${ORG_KEY}`,
          "x-workspace-id": "proj-other-org",
        },
      });
      expect(res.status).toBe(401);
    });

    it("org key on a requireWorkspace:false route succeeds without a header", async () => {
      const res = await makeApp().request("/org-level", bearer(ORG_KEY));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ workspaceId: null });
    });

    it("no bearer at all → ambient session still works", async () => {
      const res = await makeApp().request("/scoped");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ workspaceId: DEFAULT_WORKSPACE });
    });

    it("a non-oc_ bearer still falls through to session auth", async () => {
      const res = await makeApp().request("/scoped", bearer("some-jwt"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ workspaceId: DEFAULT_WORKSPACE });
    });

    it("a kind:user workspace key authenticates to its own workspace", async () => {
      const res = await makeApp().request(
        "/scoped",
        bearer(WORKSPACE_USER_KEY),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ workspaceId: TARGET_WORKSPACE });
    });

    it("a kind:service workspace key is REJECTED with 401 — a machine key can't reach /v1", async () => {
      // MUTATION-TESTED: delete `if (apiKey.kind === "service") return
      // "invalid-key"` in api-key.ts and this 200s — a leaked channel-presence
      // approvals key could then call POST /v1/agents/:id/regenerate-token and
      // lift the agent's proxy credential (the very thing the gateway injects
      // with). The narrow machine key must never authenticate the general /v1
      // surface. The refusal is the same generic 401 as any invalid key.
      const res = await makeApp().request(
        "/scoped",
        bearer(WORKSPACE_SERVICE_KEY),
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.message).toBe("Invalid API key or token.");
    });
  });

  // No edition ships strict OFF any more — this describe pins the legacy
  // fallthrough behind the test seam, i.e. exactly the hazard the strict
  // default closes.
  describe("strict OFF (test seam only) — the legacy fallthrough", () => {
    it("org key without X-Workspace-Id falls through to the ambient session", async () => {
      const res = await makeApp().request("/scoped", bearer(ORG_KEY));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ workspaceId: DEFAULT_WORKSPACE });
    });

    it("unknown oc_ key falls through to the ambient session", async () => {
      const res = await makeApp().request("/scoped", bearer("oc_bogus"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ workspaceId: DEFAULT_WORKSPACE });
    });
  });
});

describe("the shipped default", () => {
  it("is strict in every edition (this file runs pinned to onprem)", async () => {
    // The suite above mutates the module singleton through the seam; a fresh
    // module instance shows what ships.
    vi.resetModules();
    const { getStrictApiKeyAuth } =
      await import("../providers/strict-api-keys");
    expect(getStrictApiKeyAuth()).toBe(true);
  });
});
