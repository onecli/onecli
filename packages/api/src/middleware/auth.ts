import { createMiddleware } from "hono/factory";
import type { AuthContext, OrgRole } from "../providers";
import {
  getRoleResolver,
  getStrictApiKeyAuth,
  ROLE_HIERARCHY,
} from "../providers";
import { CAPS } from "../lib/env";
import { ServiceError } from "../services/errors";
import type { ApiEnv } from "../types";
import { authenticateApiKey } from "./auth/api-key";
import { hasActiveMembership } from "./auth/resolve";
import { authenticateSession } from "./auth/session";

export interface AuthOptions {
  requireWorkspace?: boolean;
  role?: OrgRole;
}

const UNAUTHORIZED = {
  error: {
    message: "Invalid API key or token.",
    type: "authentication_error",
  },
} as const;

const MISSING_WORKSPACE_HEADER = {
  error: {
    message: "X-Workspace-Id (formerly X-Project-Id) header is required",
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
  const requireWorkspace = options?.requireWorkspace ?? true;
  const minimumRole = options?.role;

  return createMiddleware<ApiEnv>(async (c, next) => {
    // A browser navigation that can't set request headers — the app-connect →
    // GET /v1/apps/:provider/authorize redirect — carries its scope in the query
    // string (_token/_workspace/_org). Bridge it into the headers every auth path
    // reads, ONCE up front, so the ambient local session (no _token JWT)
    // resolves the popup's workspace too — not only the query-token (cloud)
    // path. Never override a real header/Authorization, so an API key or a
    // header-scoped request keeps precedence; resolveWorkspaceId still validates
    // org membership before trusting x-workspace-id.
    let request = c.req.raw;
    const queryToken = c.req.query("_token");
    const queryWorkspace = c.req.query("_workspace");
    const queryOrg = c.req.query("_org");
    if (queryToken || queryWorkspace || queryOrg) {
      try {
        const headers = new Headers(request.headers);
        if (queryToken && !headers.has("authorization")) {
          headers.set("authorization", `Bearer ${queryToken}`);
        }
        if (queryWorkspace && !headers.has("x-workspace-id")) {
          headers.set("x-workspace-id", queryWorkspace);
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

    // API key (workspace or org)
    const apiKeyAuth = await authenticateApiKey(request, requireWorkspace);
    let authResult: AuthContext | null =
      typeof apiKeyAuth === "string" ? null : apiKeyAuth;

    // Strict API-key mode (EE editions): an `oc_` bearer commits to API-key
    // auth — a failed key authentication 401s instead of falling through to
    // session auth, where an ambient local session would silently resolve the
    // caller to the user's default workspace. Strict in EVERY edition since the
    // overlay dissolved (the hazard is onprem's ambient local session); the
    // flag survives as a test seam.
    if (getStrictApiKeyAuth()) {
      if (apiKeyAuth === "missing-workspace") {
        return c.json(MISSING_WORKSPACE_HEADER, 401);
      }
      if (apiKeyAuth === "invalid-key") {
        return c.json(UNAUTHORIZED, 401);
      }
    }

    // Session — cloud reads the JWT from Authorization; self-host reads the
    // session cookie
    if (!authResult) {
      const sessionAuth = await authenticateSession(request, requireWorkspace);
      if (sessionAuth && "denied" in sessionAuth) {
        // The edition's session enforcer rejected a valid session (e.g.
        // enterprise "require SSO") — explicit 401, never the generic one.
        return c.json(
          {
            error: {
              message: sessionAuth.denied.error,
              type: "authentication_error",
              code: sessionAuth.denied.code,
            },
          },
          401,
        );
      }
      authResult = sessionAuth;
    }

    if (!authResult) {
      return c.json(UNAUTHORIZED, 401);
    }

    // Role check (only when role option is specified). Non-RBAC
    // deployments (unlicensed self-host) enforce no roles — every active
    // member passes, the same flat-team choke point `requireRole`,
    // `userIsOrgAdmin`, and the invitations router already apply.
    if (minimumRole) {
      if (CAPS.rbac) {
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
      } else if (
        // Flat team: no role enforcement, but the ACTIVE-MEMBERSHIP fence
        // still holds. Session principals proved it during org resolution
        // (resolve.ts); API-key principals carry the org from the key row,
        // so a departed or suspended holder's key must be re-fenced here
        // before it can exercise a role-gated surface.
        !(await hasActiveMembership(
          authResult.userId,
          authResult.organizationId,
        ))
      ) {
        return c.json(FORBIDDEN_NOT_MEMBER, 403);
      }
    }

    c.set("auth", authResult);
    return next();
  });
};

export const authMiddleware = auth();

export const requireWorkspaceId = (auth: AuthContext): string => {
  if (!auth.workspaceId)
    throw new ServiceError(
      "BAD_REQUEST",
      "X-Workspace-Id (formerly X-Project-Id) header is required",
    );
  return auth.workspaceId;
};
