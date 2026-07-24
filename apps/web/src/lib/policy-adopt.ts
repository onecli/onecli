/**
 * OSS no-op seam. OSS has no pre-cutover bridge era — nothing ever writes
 * `policy_rules_v2` there before its 9.5 release-as-cutover — so its
 * app-permission rows are adopted AT TRANSLATION TIME (the cutover tags them
 * `source: "custom"` directly; see `policy-oss-translate`) and there is
 * nothing to re-tag here. The EE editions (cloud + both onprems) swap this for
 * the real adoption pass via the next.config `resolveAlias`
 * (`@/ee/policy-adopt`); instrumentation calls the seam unconditionally and
 * each impl self-gates on the editing flag.
 */
export const runPolicyAdoption = async (): Promise<void> => {};
