/**
 * The onprem edition's default policy validator: the edition DEFAULT for the
 * `policyValidator` provider hook when nothing is injected (cloud's default is
 * `eePolicyValidator` — the SAME shape validation plus the plan gate; tests
 * still inject their own through the `policyValidator` option or
 * `initPolicyValidator`).
 *
 * Shape-only, no plan gating: onprem's single enforcing gateway executes
 * granular resource scoping and conditions exactly like cloud's, so writes
 * validate the shared provider shape (`github-app` repositories / `dropbox`
 * folders) and store what passes. This replaced the former "locks" module,
 * which hard-422'd all granular scoping on the premise that the onprem
 * gateway never enforced it — false since the one-catalog gateway.
 *
 * No `validateTargets` either (absent = permissive, matching cloud): the
 * one-catalog gateway enforces every provider, so app targets need no
 * per-edition fence.
 *
 * CLIENT-BUNDLE: the `policyValidator` provider statically imports this
 * module, and that provider is client-reachable via the providers barrel —
 * import ONLY client-safe modules here statically (`ServiceError`-class
 * things; never the quota/plan graph, the DB client, or Node builtins). The
 * shape validators are LICENSED (`ee/granular-access/shape`), so they load
 * lazily inside `validate()`: a dynamic import is a declared seam, not a
 * dependency — the free build never evaluates them (bundlers may still emit
 * the deferred chunk), and the entitled-onprem default
 * (`providers/hooks/policy-validator.ts`) asserts the granular_access
 * entitlement before this ever runs.
 */
import type { PolicyValidator } from "../providers/hooks/policy-validator";

export const onpremPolicyValidator: PolicyValidator = {
  validate: async (_organizationId, provider, metadata, policy) => {
    const { validatePolicyShape } = await import("../ee/granular-access/shape");
    return validatePolicyShape(provider, metadata, policy);
  },
};
