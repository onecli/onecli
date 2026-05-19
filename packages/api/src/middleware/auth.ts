import { createMiddleware } from "hono/factory";
import { validateApiKey } from "../lib/validate-api-key";
import type { AuthContext, SessionProvider } from "../providers";
import { getSessionProvider } from "../providers";
import type { ApiEnv } from "../types";
import { db } from "@onecli/db";
import { findUserDefaultProject } from "../services/organization-service";

const resolveOrganizationId = async (
  projectId: string,
): Promise<string | null> => {
  const project = await db.project.findFirst({
    where: { id: projectId },
    select: { organizationId: true },
  });
  return project?.organizationId ?? null;
};

export const authenticateWithSession = async (
  session: SessionProvider,
  request: Request,
): Promise<AuthContext | null> => {
  const user = await session.getSession(request);
  if (!user) return null;

  const dbUser = await db.user.findUnique({
    where: { externalAuthId: user.id },
    select: { id: true },
  });
  if (!dbUser) return null;

  const projectId =
    (await session.resolveProjectForUser(dbUser.id, request)) ??
    (await findUserDefaultProject(dbUser.id))?.id ??
    null;
  if (!projectId) return null;

  const organizationId = await resolveOrganizationId(projectId);
  if (!organizationId) return null;

  return { userId: dbUser.id, projectId, organizationId };
};

export const authMiddleware = createMiddleware<ApiEnv>(async (c, next) => {
  // 1. API key
  const apiKeyAuth = await validateApiKey(c.req.raw);
  if (apiKeyAuth) {
    const orgId = await resolveOrganizationId(apiKeyAuth.projectId);
    if (!orgId) return c.json({ error: "Unauthorized" }, 401);
    c.set("auth", { ...apiKeyAuth, organizationId: orgId });
    return next();
  }

  const session = getSessionProvider();

  // 2. JWT from Authorization header
  const headerAuth = await authenticateWithSession(session, c.req.raw);
  if (headerAuth) {
    c.set("auth", headerAuth);
    return next();
  }

  // 3. JWT from query params (browser navigations to cross-origin api-server)
  const url = new URL(c.req.url);
  const queryToken = url.searchParams.get("_token");
  if (queryToken) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("authorization", `Bearer ${queryToken}`);
    const queryProject = url.searchParams.get("_project");
    if (queryProject) headers.set("x-project-id", queryProject);

    const queryAuth = await authenticateWithSession(
      session,
      new Request(c.req.url, { headers }),
    );
    if (queryAuth) {
      c.set("auth", queryAuth);
      return next();
    }
  }

  return c.json({ error: "Unauthorized" }, 401);
});
