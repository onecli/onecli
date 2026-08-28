/**
 * Server-side entitlement refusal, shared by every gate: the plan-agnostic
 * "this needs an enterprise license" error. Lives outside `ee/` because the
 * shared provider seams (rule-action gate, policy validator) call it and
 * shared code must never import licensed code.
 */
import { ServiceError } from "../services/errors";
import {
  ENTERPRISE_FEATURES,
  isEntitled,
  type EnterpriseFeature,
} from "./entitlements";

/** The message every entitlement refusal carries, keyed by feature label. */
export const enterpriseLicenseMessage = (feature: EnterpriseFeature): string =>
  `${ENTERPRISE_FEATURES[feature]} requires a OneCLI Enterprise license.`;

/**
 * Throw unless this deployment may run `feature`. Cloud always passes (plans
 * gate there); self-host requires `ENTERPRISE_ENABLED=true`.
 */
export const assertEntitled = (feature: EnterpriseFeature): void => {
  if (isEntitled()) return;
  throw new ServiceError("FORBIDDEN", enterpriseLicenseMessage(feature));
};
