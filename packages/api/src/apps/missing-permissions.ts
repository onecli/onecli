// Which of an OAuth app's requested permissions a connection was NOT granted.
//
// Consent screens (Google's in particular) let the user untick individual
// permissions, and the token exchange still succeeds with the narrower grant.
// The connection then half-works: e.g. a Google Drive connection without
// `drive.readonly` cannot list folders it didn't create. The dashboard uses
// this to flag the connection and offer a reconnect.
//
// CLIENT-SAFE: imported by client components, so it stays pure (registry +
// types only, no DB, crypto, or service imports).

import type { OAuthPermission } from "./types";
import { getApp } from "./registry";

/** One requested permission a grant lacks: the public, app-defined fields. */
export type MissingPermission = Pick<
  OAuthPermission,
  "scope" | "name" | "description"
>;

/** Identity scopes never gate a feature, so their absence isn't flagged. */
const IDENTITY_SCOPES = new Set([
  "openid",
  "email",
  "profile",
  "offline_access",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
]);

const GOOGLE = "https://www.googleapis.com/auth/";

/**
 * Google scopes that grant everything a NARROWER requested scope does, for
 * grants that hold the broad one instead (connections made while an app still
 * requested it). Only pairs Google's API reference lists interchangeably are
 * here: a sibling such as `contacts.other.readonly` or `youtube.force-ssl` is
 * a separate permission, never implied by its prefix.
 */
const GOOGLE_SUPERSETS: Record<string, readonly string[]> = {
  [`${GOOGLE}drive`]: [`${GOOGLE}drive.readonly`, `${GOOGLE}drive.file`],
  [`${GOOGLE}calendar`]: [
    `${GOOGLE}calendar.readonly`,
    `${GOOGLE}calendar.events`,
  ],
};

/**
 * Whether a granted scope satisfies a requested one. Exact match
 * (case-insensitive: Microsoft echoes scopes in its own casing), plus the
 * broader-covers-narrower rules providers actually document:
 * - Google: `<scope>` covers `<scope>.readonly`, and the supersets above.
 * - Microsoft Graph: `X.ReadWrite[.All]` covers `X.Read[.All]`.
 */
const covers = (granted: string, wanted: string): boolean => {
  const g = granted.toLowerCase();
  const w = wanted.toLowerCase();
  if (g === w) return true;
  if (g.startsWith(GOOGLE) && w === `${g}.readonly`) return true;
  if (GOOGLE_SUPERSETS[g]?.includes(w)) return true;
  const readWrite = /^(.+)\.readwrite(\.all)?$/.exec(g);
  return (
    readWrite !== null && w === `${readWrite[1]}.read${readWrite[2] ?? ""}`
  );
};

/**
 * `provider`'s requested, described, non-identity permissions whose scope
 * passes `keep`, once per scope (an app may describe one scope twice, e.g.
 * HubSpot's `tickets` for read and write). Only scopes the app both requests
 * (`defaultScopes`) and describes (`permissions`) can ever come back, so an
 * arbitrary scope string can't surface text that isn't the app's own.
 */
export const describeScopes = (
  provider: string,
  keep: (scope: string) => boolean,
): MissingPermission[] => {
  const method = getApp(provider)?.connectionMethod;
  if (method?.type !== "oauth") return [];
  const requested = new Set(method.defaultScopes ?? []);
  const seen = new Set<string>();
  return (method.permissions ?? []).flatMap(({ scope, name, description }) => {
    if (
      seen.has(scope) ||
      !requested.has(scope) ||
      IDENTITY_SCOPES.has(scope) ||
      !keep(scope)
    ) {
      return [];
    }
    seen.add(scope);
    return [{ scope, name, description }];
  });
};

/**
 * The described permissions `provider` asks for that `grantedScopes` lacks.
 * An empty grant list means the provider didn't report scopes: nothing can be
 * concluded, so nothing is flagged.
 */
export const missingPermissions = (
  provider: string,
  grantedScopes: readonly string[] | null | undefined,
): MissingPermission[] => {
  // Stored grants from before a provider's scope string was parsed correctly
  // can hold one comma- or space-joined entry (monday.com's did).
  const granted = (grantedScopes ?? []).flatMap((s) =>
    s.split(/[\s,]+/).filter(Boolean),
  );
  if (granted.length === 0) return [];
  return describeScopes(
    provider,
    (scope) => !granted.some((g) => covers(g, scope)),
  );
};

/** Whether a connection lacks a specific requested scope (feature gates like
 * the Drive folder picker ask about the one scope they need). */
export const lacksScope = (
  provider: string,
  grantedScopes: readonly string[] | null | undefined,
  scope: string,
): boolean =>
  missingPermissions(provider, grantedScopes).some((p) => p.scope === scope);

/**
 * Adds the partial-grant warning to an OAuth callback's success redirect: the
 * scope ids the user didn't grant (`missing`, public and app-defined; the page
 * resolves them against the app's own list), plus what "Try again" needs to
 * re-authenticate the SAME connection: its id (`connectionId`, the popup's
 * existing "re-authenticate this connection" param) and the scope it lives in
 * (`workspaceId` or `orgId`; the popup page is outside both, so it can't read
 * them from its own URL). Shared by the workspace and org callbacks; the
 * authorize leg re-checks the caller's access to that scope and connection.
 */
export const setPartialGrantParams = (
  params: URLSearchParams,
  provider: string,
  grantedScopes: readonly string[],
  retry: {
    connectionId: string;
    scope: { workspaceId: string } | { orgId: string };
  },
): void => {
  const missing = missingPermissions(provider, grantedScopes);
  if (missing.length === 0) return;
  params.set("missing", missing.map((p) => p.scope).join(" "));
  params.set("connectionId", retry.connectionId);
  if ("workspaceId" in retry.scope) {
    params.set("workspaceId", retry.scope.workspaceId);
  } else {
    params.set("orgId", retry.scope.orgId);
  }
};
