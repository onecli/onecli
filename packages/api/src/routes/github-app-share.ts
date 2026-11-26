import type { Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { ApiEnv } from "../types";
import { requireWorkspaceId } from "../middleware/auth";
import {
  GITHUB_APP_PROVIDER,
  getConnectionRepositories,
  refreshConnectionRepositories,
  listSharedInstallations,
  shareInstallationWithOrganization,
  setConnectionRepositories,
  type ShareCaller,
} from "../services/github-app-share-service";
import {
  grantConnectingAgent,
  resolveConnectingAgent,
} from "../services/agent-connect-grant-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../services/audit-service";

type Auth = ApiEnv["Variables"]["auth"];

const shareSchema = z
  .object({
    sourceConnectionId: z.string().min(1).max(64),
    /** The agent a workspace share started from: the shared connection is on
     * for it (`agent-connect-grant-service`). Workspace level only. */
    agentId: z.string().min(1).max(64).optional(),
  })
  .strict();

const editSchema = z
  .object({
    /** Null explicitly selects every repo the installation grants. */
    repositories: z.array(z.string().min(1).max(200)).max(500).nullable(),
  })
  .strict();

/**
 * Shared GitHub App installations, mounted on the workspace apps router
 * (`/v1/apps/github-app/…`) and on the org apps router
 * (`/v1/org/apps/github-app/…`, behind the admin role like every org
 * connection write). Org admins only at both levels: the service refuses
 * anyone else (see `github-app-share-service`).
 *
 *   GET  /github-app/installations                     installations in the org
 *   POST /github-app/connections                       share one with the org (moves it up)
 *   GET  /github-app/connections/:id/repositories      a connection's repos (live, read-only)
 *   PATCH /github-app/connections/:id                  change a connection's repos
 */
export const registerGitHubAppShareRoutes = (
  app: Hono<ApiEnv>,
  guard: MiddlewareHandler<ApiEnv>,
  level: "workspace" | "organization",
) => {
  const callerOf = (auth: Auth): ShareCaller => ({
    organizationId: auth.organizationId,
    userId: auth.userId,
    target:
      level === "workspace"
        ? { workspaceId: requireWorkspaceId(auth) }
        : { organizationId: auth.organizationId },
  });

  app.get(`/${GITHUB_APP_PROVIDER}/installations`, guard, async (c) => {
    const installations = await listSharedInstallations(
      callerOf(c.get("auth")),
    );
    return c.json(installations);
  });

  // Share an installation with the whole org: its connection moves up to the
  // org level (no copy), and every workspace inherits it.
  app.post(`/${GITHUB_APP_PROVIDER}/connections`, guard, async (c) => {
    const auth = c.get("auth");
    const parsed = shareSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "BAD_REQUEST",
            message: "Invalid request",
            details: parsed.error.issues,
          },
        },
        400,
      );
    }
    const caller = callerOf(auth);
    const target = caller.target;
    // Agents live in workspaces: an org-level share naming one is a 400.
    const connectingAgentId = await resolveConnectingAgent(
      target.workspaceId,
      parsed.data.agentId,
    );

    const shared = await withAudit(
      async () => {
        const conn = await shareInstallationWithOrganization({
          caller,
          sourceConnectionId: parsed.data.sourceConnectionId,
        });
        // Shared from an agent's page: on for that agent. Inside the audited
        // action so the gateway flush that follows sees the grant too.
        if (target.workspaceId) {
          await grantConnectingAgent(
            target.workspaceId,
            conn.id,
            connectingAgentId,
            auth.userId,
          );
        }
        return conn;
      },
      (conn) => ({
        organizationId: auth.organizationId,
        userId: auth.userId,
        userEmail: auth.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.APP_CONNECTION,
        source: AUDIT_SOURCE.API,
        metadata: {
          connectionId: conn.id,
          provider: GITHUB_APP_PROVIDER,
          change: "promoted_to_organization",
        },
      }),
    );
    return c.json(shared);
  });

  app.get(
    `/${GITHUB_APP_PROVIDER}/connections/:connectionId/repositories`,
    guard,
    async (c) =>
      c.json(
        await getConnectionRepositories(
          callerOf(c.get("auth")),
          c.req.param("connectionId"),
        ),
      ),
  );

  app.post(
    `/${GITHUB_APP_PROVIDER}/connections/:connectionId/repository-refresh`,
    guard,
    async (c) => {
      const auth = c.get("auth");
      const caller = callerOf(auth);
      const target = caller.target;
      const refreshed = await withAudit(
        () =>
          refreshConnectionRepositories(caller, c.req.param("connectionId")),
        () => ({
          ...(target.workspaceId
            ? { workspaceId: target.workspaceId }
            : { organizationId: auth.organizationId }),
          userId: auth.userId,
          userEmail: auth.userEmail,
          action: AUDIT_ACTIONS.UPDATE,
          service: AUDIT_SERVICES.APP_CONNECTION,
          source: AUDIT_SOURCE.API,
          metadata: {
            connectionId: c.req.param("connectionId"),
            provider: GITHUB_APP_PROVIDER,
            change: "repositories_refreshed",
          },
        }),
      );
      return c.json(refreshed);
    },
  );

  app.patch(
    `/${GITHUB_APP_PROVIDER}/connections/:connectionId`,
    guard,
    async (c) => {
      const auth = c.get("auth");
      const parsed = editSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "Invalid request",
              details: parsed.error.issues,
            },
          },
          400,
        );
      }
      const caller = callerOf(auth);
      const target = caller.target;
      const updated = await withAudit(
        () =>
          setConnectionRepositories({
            caller,
            connectionId: c.req.param("connectionId"),
            repositories: parsed.data.repositories ?? undefined,
          }),
        (conn) => ({
          ...(target.workspaceId
            ? { workspaceId: target.workspaceId }
            : { organizationId: auth.organizationId }),
          userId: auth.userId,
          userEmail: auth.userEmail,
          action: AUDIT_ACTIONS.UPDATE,
          service: AUDIT_SERVICES.APP_CONNECTION,
          source: AUDIT_SOURCE.API,
          metadata: {
            connectionId: conn.id,
            provider: GITHUB_APP_PROVIDER,
            repositories: conn.repositories?.length ?? "all",
          },
        }),
      );
      return c.json(updated);
    },
  );
};
