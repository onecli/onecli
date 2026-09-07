export type Plan =
  | "free"
  | "pro"
  | "team"
  | "team-legacy"
  | "scale"
  | "enterprise"
  | "aws-marketplace";

export type SubscriptionStatus = Plan;

/** Self-serve billing interval (yearly = pay 10 months, get 12). */
export type BillingInterval = "month" | "year";

export const normalizePlan = (status: SubscriptionStatus | string): Plan => {
  switch (status) {
    case "pro":
      return "pro";
    case "team":
      return "team";
    case "team-legacy":
      return "team-legacy";
    case "scale":
      return "scale";
    case "enterprise":
      return "enterprise";
    case "aws-marketplace":
      return "aws-marketplace";
    default:
      return "free";
  }
};

export interface PlanLimits {
  maxAgents: number;
  maxWorkspaces: number;
  maxSecrets: number;
  maxOAuthApps: number;
  maxMembers: number;
  maxIntegrationCalls: number;
  auditLogDays: number;
}

export interface PlanConfig {
  id: Plan;
  name: string;
  tagline: string;
  subtitle: string;
  /** Monthly price in whole USD. */
  price: number;
  /** Yearly price in whole USD (pay 10 months, get 12). */
  yearlyPrice: number;
  priceSub?: string;
  limits: PlanLimits;
  features: string[];
  highlighted?: boolean;
}

export const PLANS: PlanConfig[] = [
  {
    id: "free",
    name: "Free",
    tagline: "Get Started",
    subtitle: "For personal use",
    price: 0,
    yearlyPrice: 0,
    priceSub: "Free forever",
    limits: {
      maxAgents: 2,
      maxWorkspaces: 1,
      maxSecrets: 10,
      maxOAuthApps: 3,
      maxMembers: 3,
      maxIntegrationCalls: 500,
      auditLogDays: 1,
    },
    features: [
      "500 integration calls/mo",
      "1 workspace",
      "10 secrets",
      "3 OAuth app connections",
      "Block rules",
      "1-day audit logs",
      "Community support",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    tagline: "Small Workspaces",
    subtitle: "For developers shipping agents to production",
    price: 25,
    yearlyPrice: 250,
    priceSub: "3 agents included",
    highlighted: true,
    limits: {
      maxAgents: 3,
      maxWorkspaces: Infinity,
      maxSecrets: Infinity,
      maxOAuthApps: Infinity,
      maxMembers: Infinity,
      maxIntegrationCalls: Infinity,
      auditLogDays: 7,
    },
    features: [
      "Unlimited integration calls",
      "Unlimited workspaces",
      "Unlimited secrets",
      "Unlimited OAuth apps",
      "Rate limit + block rules",
      "7-day audit logs",
      "Email support",
    ],
  },
  {
    id: "team",
    name: "Team",
    tagline: "Growing Teams",
    subtitle: "For teams collaborating on agent infrastructure",
    price: 149,
    yearlyPrice: 1490,
    priceSub: "10 agents included",
    limits: {
      maxAgents: 10,
      maxWorkspaces: Infinity,
      maxSecrets: Infinity,
      maxOAuthApps: Infinity,
      maxMembers: 5,
      maxIntegrationCalls: Infinity,
      auditLogDays: 30,
    },
    features: [
      "Everything in Free",
      "Shared workspaces",
      "Approval workflows",
      "30-day audit logs",
      "Priority support",
    ],
  },
  // The pre-Aug-2026 Team plan ($199/mo, $1,990/yr, plus the $200/mo price
  // from before July 2026). Retired: grandfathered subscribers keep its
  // higher limits and their price, but it is never offered to anyone else.
  {
    id: "team-legacy",
    name: "Team (Legacy)",
    tagline: "Growing Teams",
    subtitle: "For teams collaborating on agent infrastructure",
    price: 199,
    yearlyPrice: 1990,
    priceSub: "20 agents included",
    limits: {
      maxAgents: 20,
      maxWorkspaces: Infinity,
      maxSecrets: Infinity,
      maxOAuthApps: Infinity,
      maxMembers: 10,
      maxIntegrationCalls: Infinity,
      auditLogDays: 30,
    },
    features: [
      "Everything in Free",
      "Shared workspaces",
      "Approval workflows",
      "30-day audit logs",
      "Priority support",
    ],
  },
  {
    id: "scale",
    name: "Scale",
    tagline: "Scaling Companies",
    subtitle: "For companies running fleets of agents",
    price: 499,
    yearlyPrice: 4990,
    priceSub: "20 agents included",
    limits: {
      maxAgents: 20,
      maxWorkspaces: Infinity,
      maxSecrets: Infinity,
      maxOAuthApps: Infinity,
      maxMembers: 10,
      maxIntegrationCalls: Infinity,
      auditLogDays: 90,
    },
    features: [
      "Everything in Team",
      "All policy rules",
      "Dedicated Slack support",
      "90-day audit logs",
      "SLA",
    ],
  },
];

export const ENTERPRISE_PLAN = {
  name: "Enterprise",
  tagline: "Custom Deployments",
  subtitle: "For organizations with custom requirements",
  features: [
    "Custom agent limits",
    "Custom integrations",
    "All policy rules",
    "SSO & SAML",
    "VPC or on-prem deployment",
    "Custom audit log retention",
    "Dedicated engineering support",
    "Custom terms & SLA",
  ],
  contactEmail: "sales@onecli.sh",
} as const;

/**
 * Enterprise is sales-managed but lives in Stripe like every plan: ops makes
 * an org enterprise by creating a subscription with the enterprise price
 * (STRIPE_ENTERPRISE_PRICE_ID) on its Stripe customer from the dashboard —
 * webhooks and the billing reconcile-on-read then converge
 * `subscriptionStatus` to "enterprise", and cancelling that subscription
 * correctly downgrades. Never hand-write the DB column: any code path that
 * consults Stripe will overwrite it (that failure mode is why the original
 * direct-DB-write flow was replaced).
 *
 * It resolves through `getPlanConfig` but is deliberately NOT in `PLANS`:
 * the self-serve upgrade grid and plan-switch flows must never offer it
 * (sales-managed orgs are rejected in the billing routes before any Stripe
 * call).
 */
export const ENTERPRISE_PLAN_CONFIG: PlanConfig = {
  id: "enterprise",
  name: ENTERPRISE_PLAN.name,
  tagline: ENTERPRISE_PLAN.tagline,
  subtitle: ENTERPRISE_PLAN.subtitle,
  price: 0,
  yearlyPrice: 0,
  priceSub: "Custom pricing",
  limits: {
    maxAgents: Infinity,
    maxWorkspaces: Infinity,
    maxSecrets: Infinity,
    maxOAuthApps: Infinity,
    maxMembers: Infinity,
    maxIntegrationCalls: Infinity,
    auditLogDays: 90,
  },
  features: [...ENTERPRISE_PLAN.features],
};

/**
 * The AWS Marketplace Team Plan (plans/aws-marketplace-listing.md): a
 * 12-month contract bought through AWS Marketplace — 10 agents included,
 * extra agents metered as overage (soft cap, never blocked). Marketplace-
 * managed like enterprise is sales-managed: it is NOT in `PLANS` (never
 * offered via self-serve checkout), and `subscriptionStatus` is written by
 * the marketplace fulfillment/SNS flows, not by Stripe reconciliation.
 * `maxAgents` here is the base contract; the effective entitlement
 * (base + committed extras) lives on AwsMarketplaceSubscription.
 */
export const AWS_MARKETPLACE_PLAN_CONFIG: PlanConfig = {
  id: "aws-marketplace",
  name: "Team (AWS Marketplace)",
  tagline: "Billed through AWS",
  subtitle: "12-month contract via AWS Marketplace",
  price: 1650,
  yearlyPrice: 19800,
  priceSub: "10 agents included",
  limits: {
    maxAgents: 10,
    maxWorkspaces: Infinity,
    maxSecrets: Infinity,
    maxOAuthApps: Infinity,
    maxMembers: Infinity,
    maxIntegrationCalls: Infinity,
    auditLogDays: 90,
  },
  features: [
    "Everything in Scale",
    "Billed through AWS Marketplace",
    "Extra agents at $1,200/agent/year",
  ],
};

const ALL_PLAN_CONFIGS: PlanConfig[] = [
  ...PLANS,
  ENTERPRISE_PLAN_CONFIG,
  AWS_MARKETPLACE_PLAN_CONFIG,
];

export const getPlanConfig = (plan: Plan): PlanConfig =>
  ALL_PLAN_CONFIGS.find((p) => p.id === plan) ?? PLANS[0]!;

export const isPaidPlan = (plan: Plan): plan is Exclude<Plan, "free"> =>
  plan !== "free";

const PLAN_RANK: Record<Plan, number> = {
  free: 0,
  pro: 1,
  // team-legacy deliberately ties with team: legacy orgs keep every
  // team-gated feature, and neither plan renders as a downgrade of the other.
  team: 2,
  "team-legacy": 2,
  scale: 3,
  "aws-marketplace": 3,
  enterprise: 4,
};

/** Ordinal tier of a plan (free < pro < team = team-legacy < scale = aws-marketplace < enterprise). */
export const planRank = (plan: Plan): number => PLAN_RANK[plan];

/** Whether `plan` is at least `min` in the tier order (free < pro < team = team-legacy < scale < enterprise). */
export const isPlanAtLeast = (plan: Plan, min: Plan): boolean =>
  planRank(plan) >= planRank(min);

/** Sales-managed plans are never purchasable or modifiable via self-serve billing. */
export const isSalesManagedPlan = (plan: Plan): boolean =>
  plan === "enterprise" || plan === "aws-marketplace";

/**
 * Plans retired from the pricing page. Grandfathered orgs keep theirs (the
 * card still renders, prices keep resolving, interval switches stay allowed),
 * but a retired plan is never offered to anyone else.
 */
export const RETIRED_PLANS: readonly Plan[] = ["pro", "team-legacy"];

/** Whether `plan` may be offered to an org currently on `currentPlan`. */
export const isPlanOffered = (plan: Plan, currentPlan: Plan): boolean =>
  !RETIRED_PLANS.includes(plan) || plan === currentPlan;

/** The self-serve plan cards shown to an org currently on `currentPlan`. */
export const offeredPlans = (currentPlan: Plan): PlanConfig[] =>
  PLANS.filter((p) => isPlanOffered(p.id, currentPlan));
