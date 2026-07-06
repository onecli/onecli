import type { CryptoService } from "../lib/crypto-types";
import type { AppDefinition } from "../apps/types";

export type OrgRole = "owner" | "admin" | "member";

export const ROLE_HIERARCHY: Record<OrgRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
};

export interface AuthContext {
  userId: string;
  userEmail: string;
  projectId?: string;
  organizationId: string;
  role?: OrgRole;
}

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

export interface SessionProvider {
  getSession(request: Request): Promise<SessionUser | null>;
}

export interface RoleResolver {
  getUserRole(userId: string, organizationId: string): Promise<OrgRole | null>;
}

export interface OAuthOrgHandlers {
  tryHandleOrgAuthorize: (
    auth: AuthContext,
    c: import("hono").Context,
    provider: string,
  ) => Promise<Response | null>;
  tryHandleOrgCallback: (
    request: Request,
    provider: string,
  ) => Promise<Response | null>;
  tryHandleOrgConnect: (
    auth: AuthContext,
    request: Request,
    provider: string,
    credentials: Record<string, unknown>,
    options?: {
      scopes?: string[];
      metadata?: Record<string, unknown>;
      label?: string;
    },
    connectionId?: string,
    fields?: Record<string, string>,
  ) => Promise<Response | null>;
}

export type { CryptoService, AppDefinition };
