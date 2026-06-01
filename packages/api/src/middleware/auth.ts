import { createMiddleware } from "hono/factory";
import type { AuthContext, OrgRole } from "../providers";
import { getRoleResolver, ROLE_HIERARCHY } from "../providers";
import { ServiceError } from "../services/errors";
import type { ApiEnv } from "../types";
import { authenticateApiKey } from "./auth/api-key";
import { authenticateSession } from "./auth/session";

export interface AuthOptions {
  requireProject?: boolean;
  role?: OrgRole;
}

const UNAUTHORIZED = {
  error: {
    message: "Invalid API key or token.",
    type: "authentication_error",
  },
} as const;

const FORBIDDEN_NOT_MEMBER = {
  error: {
    message: "Not a member of this organization",
    type: "authentication_error",
  },
} as const;

const FORBIDDEN_INSUFFICIENT = {
  error: {
    message: "Insufficient permissions",
    type: "authentication_error",
  },
} as const;

export const auth = (options?: AuthOptions) => {
  const requireProject = options?.requireProject ?? true;
  const minimumRole = options?.role;

  return createMiddleware<ApiEnv>(async (c, next) => {
    let authResult: AuthContext | null = null;

    // 1. API key (project or org)
    authResult = await authenticateApiKey(c.req.raw, requireProject);

    // 2. JWT from Authorization header
    if (!authResult) {
      authResult = await authenticateSession(c.req.raw, requireProject);
    }

    // 3. JWT from query params (browser navigations)
    if (!authResult) {
      const url = new URL(c.req.url);
      const queryToken = url.searchParams.get("_token");
      if (queryToken) {
        const headers = new Headers(c.req.raw.headers);
        headers.set("authorization", `Bearer ${queryToken}`);
        const queryProject = url.searchParams.get("_project");
        if (queryProject) headers.set("x-project-id", queryProject);
        const queryOrg = url.searchParams.get("_org");
        if (queryOrg) headers.set("x-organization-id", queryOrg);

        authResult = await authenticateSession(
          new Request(c.req.url, { headers }),
          requireProject,
        );
      }
    }

    if (!authResult) {
      return c.json(UNAUTHORIZED, 401);
    }

    // 4. Role check (only when role option is specified)
    if (minimumRole) {
      const resolver = getRoleResolver();
      if (!resolver) {
        return c.json(FORBIDDEN_NOT_MEMBER, 403);
      }
      const userRole = await resolver.getUserRole(
        authResult.userId,
        authResult.organizationId,
      );
      if (!userRole) {
        return c.json(FORBIDDEN_NOT_MEMBER, 403);
      }
      if (ROLE_HIERARCHY[userRole] < ROLE_HIERARCHY[minimumRole]) {
        return c.json(FORBIDDEN_INSUFFICIENT, 403);
      }
      authResult.role = userRole;
    }

    c.set("auth", authResult);
    return next();
  });
};

export const authMiddleware = auth();

export const requireProjectId = (auth: AuthContext): string => {
  if (!auth.projectId)
    throw new ServiceError("BAD_REQUEST", "X-Project-Id header is required");
  return auth.projectId;
};
