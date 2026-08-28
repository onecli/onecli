/**
 * OneCLI edition + capability model — the single source of truth for
 * "which edition am I, and what can it do".
 *
 * Two editions exist: `cloud` (the hosted platform) and `onprem` (self-hosted —
 * the default for any unset/unknown value, including the legacy `oss` string).
 * Both serve the same org-scoped surface and URLs; call-sites read the derived
 * `capabilities` rather than branching on the raw edition string, so capability
 * changes are a data change here.
 *
 * This module is pure and dependency-free — safe to import from any runtime
 * (client, server, edge). Keep it that way.
 */

/** Distribution edition. */
export type Edition = "onprem" | "cloud";

/** Parsed build edition. */
export interface EditionInfo {
  edition: Edition;
}

/**
 * Normalize the raw `*_EDITION` env value into `{ edition }`.
 *
 * Empty or any unrecognized value (including the legacy `oss`) → `onprem`.
 */
export const parseEdition = (raw: string | undefined | null): EditionInfo => {
  const edition = (raw ?? "").trim().toLowerCase();
  return edition === "cloud" ? { edition: "cloud" } : { edition: "onprem" };
};

/**
 * Capabilities derived from the edition. Call-sites should branch on these
 * rather than on the raw edition, so new editions are a data change here.
 */
export interface Capabilities {
  /** Identity backend. */
  auth: "cognito" | "local";
  /** Whether billing / plan-gating is active. */
  billing: boolean;
  /**
   * Role-based access control is active — role enforcement in the access checks
   * (workspace access, org-admin guard, api-key) AND the member/role management UI
   * (the Team screen).
   */
  rbac: boolean;
}

const CAPABILITIES: Record<Edition, Capabilities> = {
  onprem: {
    auth: "local",
    billing: false,
    rbac: false,
  },
  cloud: {
    auth: "cognito",
    billing: true,
    rbac: true,
  },
};

/**
 * The capability set for a parsed edition. RBAC is the one capability the
 * enterprise entitlement changes: a licensed self-host enforces roles like
 * cloud does. Callers that know their entitlement pass it (the API server
 * does); callers that can't know it — client bundles, where the flag is
 * runtime-only — omit it and read entitlement from `/v1/instance` instead.
 */
export const capabilitiesFor = (
  info: EditionInfo,
  opts?: { entitled?: boolean },
): Capabilities => {
  const base = CAPABILITIES[info.edition];
  return opts?.entitled ? { ...base, rbac: true } : base;
};

/** Capabilities by edition (exported for tests / introspection). */
export { CAPABILITIES };
