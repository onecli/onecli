import type { PolicyTargetInput } from "../../validations/policy";
import { createEditionSlot } from "../edition-state";
import { onpremPolicyValidator } from "../../services/policy-onprem-validator";
import { assertEntitled } from "../../lib/entitlements-guard";

export interface PolicyValidator {
  validate(
    organizationId: string,
    provider: string,
    metadata: Record<string, unknown> | null,
    policy: Record<string, unknown>,
  ): Promise<void>;
  /**
   * Optional gate over a rule's targets, run on create/update (never publish —
   * a pre-existing row must not brick a whole-scope publish). Absent =
   * permissive; neither edition default implements it (the one-catalog
   * gateway enforces every provider) — it remains an injection point.
   */
  validateTargets?(targets: PolicyTargetInput[]): Promise<void>;
}

// Edition default when nothing is injected: cloud gates granular access by
// plan + provider shape — injected by `ensureEditionDefaults()`, keeping the
// plan/quota graph out of client bundles; onprem checks the enterprise
// entitlement (#39/#40 — resource scoping is licensed) and then validates the
// SAME provider shape (the validator module is client-safe and stays a static
// import; the entitlement guard imports only `ServiceError` + the pure
// entitlement parser, so it is client-safe too). The `policyValidator` option
// and `initPolicyValidator` remain as overrides for tests (null resets to the
// edition default).
const entitledOnpremPolicyValidator: PolicyValidator = {
  validate: async (organizationId, provider, metadata, policy) => {
    assertEntitled("granular_access");
    return onpremPolicyValidator.validate(
      organizationId,
      provider,
      metadata,
      policy,
    );
  },
};

const slot = createEditionSlot<PolicyValidator>(
  "policyValidator",
  () => entitledOnpremPolicyValidator,
);

export const initPolicyValidator = (v: PolicyValidator | null) => slot.init(v);

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultPolicyValidator = (v: PolicyValidator) =>
  slot.setCloudDefault(v);

export const getPolicyValidator = (): PolicyValidator => slot.get();
