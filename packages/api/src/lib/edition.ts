/**
 * OneCLI build edition + capability model — the single source of truth for
 * "which edition am I, and what can it do".
 *
 * Today only `oss` and `cloud` exist. The shape is intentionally extensible: a
 * future `onprem` edition (with a `variant` of `slim`/`full`) slots in here
 * without touching call-sites, which read the derived `capabilities` rather than
 * branching on the raw edition string.
 *
 * This module is pure and dependency-free — safe to import from any runtime
 * (client, server, edge). Keep it that way.
 */

/** Distribution edition. (A future `onprem` edition lands here.) */
export type Edition = "oss" | "cloud";

/** Sub-variant of an edition (e.g. a future onprem `slim` vs `full`). `null` when N/A. */
export type Variant = "slim" | "full" | null;

/** Parsed build edition + variant. */
export interface EditionInfo {
  edition: Edition;
  variant: Variant;
}

/**
 * Normalize the raw `*_EDITION` env value into `{ edition, variant }`.
 *
 * Editions may carry a variant as `"<edition>-<variant>"` (e.g. a future
 * `"onprem-slim"`); today only the edition segment is meaningful, so `variant`
 * is always `null`. Empty, `"oss"`, or any unrecognized value → `oss`.
 */
export const parseEdition = (raw: string | undefined | null): EditionInfo => {
  const edition = (raw ?? "").trim().toLowerCase().split("-")[0];
  switch (edition) {
    case "cloud":
      return { edition: "cloud", variant: null };
    default:
      return { edition: "oss", variant: null };
  }
};

/**
 * Capabilities derived from the edition. Call-sites should branch on these
 * rather than on the raw edition, so new editions are a data change here.
 */
export interface Capabilities {
  /** Identity backend. */
  auth: "cognito" | "local";
  /** Tenancy model. */
  tenancy: "multi-org" | "org-per-user";
  /** Whether billing / plan-gating is active. */
  billing: boolean;
}

const CAPABILITIES: Record<Edition, Capabilities> = {
  oss: { auth: "local", tenancy: "org-per-user", billing: false },
  cloud: { auth: "cognito", tenancy: "multi-org", billing: true },
};

/** The capability set for a parsed edition. */
export const capabilitiesFor = (info: EditionInfo): Capabilities =>
  CAPABILITIES[info.edition];

/** Capabilities by edition (exported for tests / introspection). */
export { CAPABILITIES };

/**
 * The web import paths the cloud edition swaps to cloud implementations via
 * turbopack `resolveAlias` in `apps/web/next.config.js`. Declared here as the
 * canonical, drift-tested set; `next.config.js` keeps the actual key→value map
 * because it runs in plain Node and cannot import this TypeScript module.
 *
 * Keep in sync with `apps/web/next.config.js` (the edition test guards this).
 */
export const CLOUD_ALIAS_KEYS: readonly string[] = [
  "@/lib/auth/auth-provider",
  "@/lib/auth/auth-server",
  "@/lib/actions/resolve-user",
  "@/lib/nav-config",
  "@dashboard/dashboard-sidebar",
  "@dashboard/dashboard-header",
  "@/lib/gateway-auth",
  "@/lib/auth/login-content",
  "@/lib/user-plan",
  "@/lib/components/request-app-slot",
  "@/lib/home-redirect",
  "@/lib/components/pro-app-dialog",
  "@/lib/components/condition-builder",
  "@/lib/dashboard/session-redirect",
  "@/lib/granular-access",
  "@/lib/plan-gate",
  "@/lib/init/api",
  "@/lib/init/server",
  "@/lib/init/client",
  "@/lib/api-fetch",
];
