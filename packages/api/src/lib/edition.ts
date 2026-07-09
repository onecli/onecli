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

/** Distribution edition. */
export type Edition = "oss" | "cloud" | "onprem";

/** Sub-variant of an edition (e.g. a future onprem `slim` vs `full`). `null` when N/A. */
export type Variant = "slim" | "full" | null;

/** Parsed build edition + variant. */
export interface EditionInfo {
  edition: Edition;
  variant: Variant;
}

/** Parse the optional `-<variant>` segment (e.g. the `slim` in `onprem-slim`). */
const parseVariant = (raw: string | undefined): Variant =>
  raw === "slim" || raw === "full" ? raw : null;

/**
 * Normalize the raw `*_EDITION` env value into `{ edition, variant }`.
 *
 * Accepts `"<edition>"` or `"<edition>-<variant>"` (e.g. `"onprem-slim"`).
 * `oss` and `cloud` carry no variant; empty, `"oss"`, or any unrecognized
 * value → `oss`.
 */
export const parseEdition = (raw: string | undefined | null): EditionInfo => {
  const [edition, variant] = (raw ?? "").trim().toLowerCase().split("-");
  switch (edition) {
    case "cloud":
      return { edition: "cloud", variant: null };
    case "onprem":
      return { edition: "onprem", variant: parseVariant(variant) };
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
  tenancy: "multi-org" | "org-per-user" | "single-org-shared";
  /** Whether billing / plan-gating is active. */
  billing: boolean;
  /**
   * Whether the web serves the org-scoped surface (org routes/nav/chrome, namespaced
   * URLs) rather than the flat one. This is the one capability that varies by VARIANT:
   * `onprem-full` shows it; `onprem-slim` (connect-only) and `oss` do not.
   */
  orgScopedUI: boolean;
  /**
   * Which web surface the edition serves: `"connect-only"` = just the app-connection
   * flow (onprem-slim's tiny web); `"full"` = the whole product UI. Variant-driven for
   * onprem (slim = connect-only, full = full); oss + cloud are full.
   */
  webSurface: "connect-only" | "full";
  /**
   * Role-based access control is active — role enforcement in the access checks
   * (project access, org-admin guard, api-key) AND the member/role management UI
   * (the Team screen). Cloud only for now; onprem flips it true when it gains RBAC.
   * Distinct from `multi-org` (how many orgs) and the `tenancy` model.
   */
  rbac: boolean;
}

const CAPABILITIES: Record<Edition, Capabilities> = {
  oss: {
    auth: "local",
    tenancy: "org-per-user",
    billing: false,
    orgScopedUI: false,
    webSurface: "full",
    rbac: false,
  },
  cloud: {
    auth: "cognito",
    tenancy: "multi-org",
    billing: true,
    orgScopedUI: true,
    webSurface: "full",
    rbac: true,
  },
  onprem: {
    auth: "local",
    tenancy: "single-org-shared",
    billing: false,
    orgScopedUI: false,
    webSurface: "connect-only",
    rbac: false,
  },
};

/**
 * The capability set for a parsed edition. Variant-aware: `onprem-full` extends the
 * onprem base with the org-scoped web surface; `onprem-slim` keeps the flat one.
 */
export const capabilitiesFor = (info: EditionInfo): Capabilities => {
  const base = CAPABILITIES[info.edition];
  if (info.edition === "onprem" && info.variant === "full") {
    return { ...base, orgScopedUI: true, webSurface: "full" };
  }
  return base;
};

/** Capabilities by edition (exported for tests / introspection). */
export { CAPABILITIES };
