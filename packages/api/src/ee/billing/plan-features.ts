import type { Plan } from "./plans";

/**
 * Premium features gated behind a paid plan, single-sourced here so the client
 * paywall and the server enforcement agree on what each feature costs. Add a
 * feature key with its minimum plan and both sides pick it up automatically.
 */
export type PremiumFeature =
  | "policy.manual_approval"
  | "policy.rate_limit"
  | "policy.deny_mode"
  | "sso"
  | "groups";

export const PREMIUM_FEATURES: Record<PremiumFeature, Plan> = {
  "policy.manual_approval": "team",
  "policy.rate_limit": "pro",
  "policy.deny_mode": "team",
  // Verified email domains + SSO.
  sso: "enterprise",
  // Directory groups and everything built on them (SCIM group sync, access
  // bindings, role mappings).
  groups: "enterprise",
};

/** The minimum plan required to use a premium feature. */
export const requiredPlanFor = (feature: PremiumFeature): Plan =>
  PREMIUM_FEATURES[feature];

/** Narrows an arbitrary string to a known premium feature. */
export const isPremiumFeature = (value: string): value is PremiumFeature =>
  value in PREMIUM_FEATURES;

/**
 * The premium feature a policy-rule action maps to, or `null` for ungated
 * actions (`block`/`allow` are always available on every plan).
 */
export const ruleActionFeature = (action: string): PremiumFeature | null => {
  switch (action) {
    case "manual_approval":
      return "policy.manual_approval";
    case "rate_limit":
      return "policy.rate_limit";
    case "identity_directory":
      // Targeting a user / user-group identity requires the directory, which
      // is enterprise-only.
      return "groups";
    default:
      return null;
  }
};
