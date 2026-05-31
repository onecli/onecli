export interface PolicyValidator {
  validate(
    organizationId: string,
    provider: string,
    metadata: Record<string, unknown> | null,
    policy: Record<string, unknown>,
  ): Promise<void>;
}

const defaultPolicyValidator: PolicyValidator = {
  validate: async () => {},
};

let _policyValidator: PolicyValidator = defaultPolicyValidator;

export const initPolicyValidator = (v: PolicyValidator) => {
  _policyValidator = v;
};

export const getPolicyValidator = (): PolicyValidator => _policyValidator;
