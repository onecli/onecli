import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "../types";
import type { AuthContext } from "../providers/types";
import { initEntitlementForTests } from "../lib/entitlements";
import { assertEntitled } from "../lib/entitlements-guard";
import { registerGitHubAppShareRoutes } from "../routes/github-app-share";

// External services and authentication are stubbed. Route registration and
// the entitlement guard remain real so an added route license gate fails.
vi.mock("../middleware/auth", () => ({
  requireWorkspaceId: (auth: AuthContext) => {
    if (!auth.workspaceId) throw new Error("Workspace required");
    return auth.workspaceId;
  },
}));

vi.mock("../services/github-app-share-service", () => ({
  GITHUB_APP_PROVIDER: "github-app",
  getConnectionRepositories: async () => ({
    available: ["example/api"],
    truncated: false,
    selected: null,
  }),
  refreshConnectionRepositories: async () => ({
    available: ["example/api"],
    truncated: false,
    selected: null,
  }),
  setConnectionRepositories: async () => ({
    id: "connection-1",
    repositories: ["example/api"],
  }),
  listSharedInstallations: async () => [],
  shareInstallationWithOrganization: async () => ({ id: "connection-1" }),
}));

vi.mock("../services/agent-connect-grant-service", () => ({
  resolveConnectingAgent: async () => undefined,
  grantConnectingAgent: async () => undefined,
}));

vi.mock("../services/audit-service", () => ({
  withAudit: async <T>(action: () => Promise<T>) => action(),
  AUDIT_ACTIONS: { UPDATE: "update" },
  AUDIT_SERVICES: { APP_CONNECTION: "app_connection" },
  AUDIT_SOURCE: { API: "api" },
}));

afterEach(() => initEntitlementForTests(null));

describe("connection repository management stays free", () => {
  it.each(["workspace", "organization"] as const)(
    "serves reads, edits and refreshes to an unlicensed flat-team member at %s scope",
    async (level) => {
      initEntitlementForTests(false);
      // Positive control: licensed resource policies really are locked here.
      expect(() => assertEntitled("granular_access")).toThrow();
      const app = new Hono<ApiEnv>();
      registerGitHubAppShareRoutes(
        app,
        async (c, next) => {
          c.set("auth", {
            userId: "member-1",
            userEmail: "member@example.com",
            organizationId: "org-1",
            ...(level === "workspace" ? { workspaceId: "workspace-1" } : {}),
            role: "member",
          });
          await next();
        },
        level,
      );
      const connectionPath = "/github-app/connections/connection-1";
      const read = await app.request(`${connectionPath}/repositories`);
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ available: ["example/api"] });
      const edit = await app.request(connectionPath, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositories: ["example/api"] }),
      });
      expect(edit.status).toBe(200);
      expect(await edit.json()).toMatchObject({
        repositories: ["example/api"],
      });
      const refresh = await app.request(
        `${connectionPath}/repository-refresh`,
        {
          method: "POST",
        },
      );
      expect(refresh.status).toBe(200);
      expect(await refresh.json()).toMatchObject({
        available: ["example/api"],
      });
    },
  );
});
