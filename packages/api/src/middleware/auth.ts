import { createMiddleware } from "hono/factory";
import type { AuthContext, OrgRole } from "../providers";
import {
  getRoleResolver,
  getStrictApiKeyAuth,
  ROLE_HIERARCHY,
} from "../providers";
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

const MISSING_PROJECT_HEADER = {
  error: {
    message: "X-Project-Id header is required",
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
    // A browser navigation that can't set request headers — the app-connect →
    // GET /v1/apps/:provider/authorize redirect — carries its scope in the query
    // string (_token/_project/_org). Bridge it into the headers every auth path
    // reads, ONCE up front, so the ambient local session (onprem-slim: no _token
    // JWT) resolves the popup's project too — not only the query-token (cloud)
    // path. Never override a real header/Authorization, so an API key or a
    // header-scoped request keeps precedence; resolveProjectId still validates
    // org membership before trusting x-project-id.
    let request = c.req.raw;
    const queryToken = c.req.query("_token");
    const queryProject = c.req.query("_project");
    const queryOrg = c.req.query("_org");
    if (queryToken || queryProject || queryOrg) {
      try {
        const headers = new Headers(request.headers);
        if (queryToken && !headers.has("authorization")) {
          headers.set("authorization", `Bearer ${queryToken}`);
        }
        if (queryProject && !headers.has("x-project-id")) {
          headers.set("x-project-id", queryProject);
        }
        if (queryOrg && !headers.has("x-organization-id")) {
          headers.set("x-organization-id", queryOrg);
        }
        // Header-only clone for the auth resolvers; c.req (the route handler's
        // request, incl. its body) is left untouched.
        request = new Request(c.req.url, { headers });
      } catch {
        // A scope param that isn't a valid Latin-1 header value (e.g. a
        // non-Latin1 char) makes Headers.set throw; fall back to the original
        // request (no bridge) rather than surfacing a 500 — auth then resolves
        // as if the param were absent.
        request = c.req.raw;
      }
    }

    // 1. API key (project or org)
    const apiKeyAuth = await authenticateApiKey(request, requireProject);
    let authResult: AuthContext | null =
      typeof apiKeyAuth === "string" ? null : apiKeyAuth;

    // Strict API-key mode (EE editions): an `oc_` bearer commits to API-key
    // auth — a failed key authentication 401s instead of falling through to
    // session auth, where onprem's ambient local session would silently
    // resolve the caller to the user's default project. OSS keeps the
    // fallthrough (flag off), where both sentinels degrade to the plain null
    // they always were.
    if (getStrictApiKeyAuth()) {
      if (apiKeyAuth === "missing-project") {
        return c.json(MISSING_PROJECT_HEADER, 401);
      }
      if (apiKeyAuth === "invalid-key") {
        return c.json(UNAUTHORIZED, 401);
      }
    }

    // 2. Session — cloud reads the JWT from Authorization; local/onprem is ambient
    if (!authResult) {
      authResult = await authenticateSession(request, requireProject);
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
