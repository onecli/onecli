/**
 * Enterprise entitlement — the single source of truth for "may this
 * deployment run enterprise features".
 *
 * Self-hosted deployments opt in with `ENTERPRISE_ENABLED=true` (the honor
 * system, backed by the OneCLI Enterprise License in each `ee/` directory).
 * Cloud is always entitled — there, billing plans decide feature access, a
 * separate dial this module never touches. A future signed-license-key
 * validator replaces the body of `isEntitled()` without touching any gate.
 *
 * This module is pure and dependency-free — safe to import from any runtime.
 * ⚠️ Client bundles always see `false` on self-host (`ENTERPRISE_ENABLED` is
 * runtime-only, never a baked `NEXT_PUBLIC_*` var), so client UI must read
 * entitlement from `GET /v1/instance`, never from this module or `CAPS`.
 */
import { parseEdition, type Edition } from "./edition";

/**
 * The features the OneCLI Enterprise License covers, with the human label the
 * locked UI and refusal messages use. Deliberately NOT the same set as the
 * billing `PremiumFeature`s: deny-mode, manual approvals and rate limits are
 * plan-gated on cloud but free on self-host, so they have no key here. The
 * `sso` and `groups` keys are shared with `PremiumFeature` on purpose — the
 * rule-action mapping (`identity_directory` → `groups`) works for both dials.
 */
export const ENTERPRISE_FEATURES = {
  sso: "Single sign-on, verified domains & SCIM",
  groups: "Directory groups",
  granular_access: "Resource-level access",
  workspace_sharing: "Workspace sharing",
  app_availability: "App availability control",
  multi_org: "Multiple organizations",
  rbac: "Role-based access control",
  provisioning: "Member provisioning",
  members_directory: "Members directory API",
  budget: "Spend budgets",
  ha: "Multi-instance operation",
} as const;

export type EnterpriseFeature = keyof typeof ENTERPRISE_FEATURES;

/** Narrows an arbitrary string to a known enterprise feature. */
export const isEnterpriseFeature = (
  value: string,
): value is EnterpriseFeature => value in ENTERPRISE_FEATURES;

/**
 * Whether a deployment is entitled to enterprise features. Pure: cloud is
 * always entitled; self-host requires the explicit opt-in flag.
 */
export const parseEntitled = (
  raw: string | undefined | null,
  edition: Edition,
): boolean => {
  if (edition === "cloud") return true;
  const value = (raw ?? "").trim().toLowerCase();
  return value === "true" || value === "1";
};

/**
 * Test-only override so suites can exercise both entitlement states without
 * mutating `process.env` (house rule). `null` restores the env-derived value.
 */
let testOverride: boolean | null = null;

export const initEntitlementForTests = (value: boolean | null): void => {
  testOverride = value;
};

/**
 * Whether THIS process is entitled, read at call time (long-lived servers pick
 * up the env exactly once per call site, like `policy-flags.ts`). The seam a
 * real license-key validator plugs into later.
 */
export const isEntitled = (): boolean => {
  if (testOverride !== null) return testOverride;
  const { edition } = parseEdition(
    process.env.EDITION ?? process.env.NEXT_PUBLIC_EDITION,
  );
  return parseEntitled(process.env.ENTERPRISE_ENABLED, edition);
};
