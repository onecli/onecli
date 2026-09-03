// AWS Marketplace SaaS listing config (plans/aws-marketplace-listing.md).
// Presence of the product code is the runtime switch: unset (dev, OSS,
// staging without a listing) disables every marketplace flow and the client
// falls back to the in-memory fake. No ARNs or account ids here — per
// CLOUD-DEVELOPMENT.md these values arrive via deploy-time env only.

export const AWS_MARKETPLACE_PRODUCT_CODE =
  process.env.AWS_MARKETPLACE_PRODUCT_CODE ?? "";

/** Contract dimension API name (the 12-month, 10-agent Team Plan). */
export const AWS_MARKETPLACE_CONTRACT_DIMENSION =
  process.env.AWS_MARKETPLACE_CONTRACT_DIMENSION ?? "team_plan";

/**
 * Overage dimension API name (extra agents, billed per agent-year). The
 * portal ties the pay-as-you-go usage dimension to the contract dimension's
 * API identifier, so on the live listing this is "team_plan" (display name
 * "Additional agent (per agent-year)").
 */
export const AWS_MARKETPLACE_OVERAGE_DIMENSION =
  process.env.AWS_MARKETPLACE_OVERAGE_DIMENSION ?? "team_plan";

/** Agents included in the base contract before overage metering starts. */
export const AWS_MARKETPLACE_INCLUDED_AGENTS = 10;

export const AWS_MARKETPLACE_REGION =
  process.env.AWS_MARKETPLACE_REGION ?? "us-east-1";

/**
 * ARN of the infra-owned SNS topic that relays AWS Marketplace EventBridge
 * license events to the api-server (packages/infra: api-server-stack).
 * The event intake only accepts SNS messages from exactly this topic.
 */
export const AWS_MARKETPLACE_SNS_TOPIC_ARN =
  process.env.AWS_MARKETPLACE_SNS_TOPIC_ARN ?? "";

export const isAwsMarketplaceConfigured = (): boolean =>
  AWS_MARKETPLACE_PRODUCT_CODE.length > 0;
