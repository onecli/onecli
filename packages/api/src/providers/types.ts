import type { CryptoService } from "../lib/crypto-types";
import type { AppDefinition } from "../apps/types";
import type { ResolvedAppCredentials } from "../apps/resolve-credentials";

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
  /**
   * Whether the auth provider proved ownership of `email` (e.g. a verified
   * email claim). Optional — providers that don't know leave it unset.
   */
  emailVerified?: boolean;
  /**
   * Federated IdP name for this session (e.g. "Google"); null/unset for
   * native sign-ins or providers that don't distinguish.
   */
  federatedProvider?: string | null;
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

/**
 * Org-level app-config reads backing the project → org → env credential
 * fallback. EE-only capability: org-level app configs are writable only
 * through the EE org surface, so OSS never registers a provider and the org
 * tier is skipped everywhere (project → env, unchanged).
 */
export interface OrgAppConfigProvider {
  /** Org-row-or-env credential resolution (mirrors the project resolver). */
  resolveCredentials(
    organizationId: string,
    app: AppDefinition,
  ): Promise<ResolvedAppCredentials | null>;
  /** The org's enabled config for one provider, if any. */
  getEnabledConfig(
    organizationId: string,
    provider: string,
  ): Promise<{ hasCredentials: boolean } | null>;
  /** All enabled org configs, keyed by provider. */
  listEnabledConfigs(
    organizationId: string,
  ): Promise<Record<string, { hasCredentials: boolean }>>;
}

export type { CryptoService, AppDefinition };
