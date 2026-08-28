import type { PolicyValidator } from "../../providers/hooks/policy-validator";
import { assertCanUseGranularAccess } from "../services/quota-service";
import { validatePolicyShape } from "./shape";

export const eePolicyValidator: PolicyValidator = {
  validate: async (organizationId, provider, metadata, policy) => {
    await assertCanUseGranularAccess(organizationId);
    return validatePolicyShape(provider, metadata, policy);
  },
};
