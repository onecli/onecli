export interface AuthContext {
  userId: string;
  projectId: string;
  organizationId: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

export interface SessionProvider {
  getSession(request: Request): Promise<SessionUser | null>;
  resolveProjectForUser(
    userId: string,
    request: Request,
  ): Promise<string | null>;
}

let _session: SessionProvider;

export const initSession = (s: SessionProvider) => {
  _session = s;
};

export const getSessionProvider = (): SessionProvider => {
  if (!_session) throw new Error("SessionProvider not initialized");
  return _session;
};

// ── Crypto ──────────────────────────────────────────────────────────────

import type { CryptoService } from "./lib/crypto-types";
import { cryptoService as defaultCrypto } from "./lib/crypto";

let _crypto: CryptoService = defaultCrypto;

export const initCrypto = (c: CryptoService) => {
  _crypto = c;
};

export const getCrypto = (): CryptoService => _crypto;

// ── Cloud app definitions ───────────────────────────────────────────────

import type { AppDefinition } from "./apps/types";
import { cloudApps as defaultCloudApps } from "./apps/cloud-app-registry";

let _cloudApps: AppDefinition[] = defaultCloudApps;

export const initCloudApps = (apps: AppDefinition[]) => {
  _cloudApps = apps;
};

export const getCloudApps = (): AppDefinition[] => _cloudApps;

// ── OAuth org handlers ──────────────────────────────────────────────────

import * as defaultOAuthOrg from "./apps/oauth-org";

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
    options?: { scopes?: string[]; metadata?: Record<string, unknown> },
    connectionId?: string,
    fields?: Record<string, string>,
  ) => Promise<Response | null>;
}

let _oauthOrg: OAuthOrgHandlers = defaultOAuthOrg;

export const initOAuthOrg = (handlers: OAuthOrgHandlers) => {
  _oauthOrg = handlers;
};

export const getOAuthOrg = (): OAuthOrgHandlers => _oauthOrg;

// ── Self URL (base URL for OAuth callbacks, etc.) ───────────────────────

import { APP_URL } from "./lib/env";

let _selfUrl: string = APP_URL;

export const initSelfUrl = (url: string) => {
  _selfUrl = url;
};

export const getSelfUrl = (): string => _selfUrl;
