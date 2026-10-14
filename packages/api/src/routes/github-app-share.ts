import type { Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { ApiEnv } from "../types";
import { requireWorkspaceId } from "../middleware/auth";
import {
  GITHUB_APP_PROVIDER,
  createSharedConnection,
  listInstallationRepos,
  listSharedInstallations,
  type ShareCaller,
} from "../services/github-app-share-service";
import { getConnectionHooks } from "../providers";
import { attachNewConnectionToAllAgents } from "../services/workspace-autoattach-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../services/audit-service";

type Auth = ApiEnv["Variables"]["auth"];

const createSchema = z.object({
  sourceConnectionId: z.string().min(1).max(64),
  /** Omit for every repo the installation grants (now and later). */
  repositories: z.array(z.string().min(1).max(200)).max(500).optional(),
});

/**
 * Shared GitHub App installations, mounted on the workspace apps router
 * (`/v1/apps/github-app/…`) and on the org apps router
 * (`/v1/org/apps/github-app/…`, behind the admin role like every org
 * connection write). Org admins only at both levels: the service refuses
 * anyone else (see `github-app-share-service`). `level` decides the scope a
 * new connection lands in.
 *
 *   GET  /github-app/installations                     installations in the org
 *   GET  /github-app/installations/:id/repositories    repos one of them grants
 *   POST /github-app/connections                       build a connection on one
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

  app.get(
    `/${GITHUB_APP_PROVIDER}/installations/:sourceConnectionId/repositories`,
    guard,
    async (c) => {
      const result = await listInstallationRepos(
        callerOf(c.get("auth")),
        c.req.param("sourceConnectionId"),
      );
      return c.json(result);
    },
  );

  app.post(`/${GITHUB_APP_PROVIDER}/connections`, guard, async (c) => {
    const auth = c.get("auth");
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
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
    await getConnectionHooks().beforeCreate(auth.organizationId);

    const created = await withAudit(
      async () => {
        const conn = await createSharedConnection({
          caller,
          sourceConnectionId: parsed.data.sourceConnectionId,
          repositories: parsed.data.repositories,
        });
        // Same as a fresh OAuth connect: a new workspace connection is on for
        // every agent right away; the post-connect dialog turns agents off.
        // Inside the audited action so the gateway flush that follows sees
        // the grants too.
        if (target.workspaceId) {
          await attachNewConnectionToAllAgents(
            target.workspaceId,
            conn.id,
            auth.userId,
          );
        }
        return conn;
      },
      (conn) => ({
        ...(target.workspaceId
          ? { workspaceId: target.workspaceId }
          : { organizationId: auth.organizationId }),
        userId: auth.userId,
        userEmail: auth.userEmail,
        action: AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.APP_CONNECTION,
        source: AUDIT_SOURCE.API,
        metadata: {
          connectionId: conn.id,
          provider: GITHUB_APP_PROVIDER,
          sourceConnectionId: conn.sourceConnectionId,
          repositories: conn.repositories ?? "all",
          ...(level === "organization" ? { scope: "organization" } : {}),
        },
      }),
    );

    return c.json(created, 201);
  });
};
