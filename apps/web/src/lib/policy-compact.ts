/**
 * OSS no-op seam. OSS never accumulates the migration's per-tool rule noise —
 * its cutover GROUPS app-permission tool rows at translation time
 * (`translateOssProjectRules`, step 9.9), so there is nothing to compact
 * retroactively. The EE editions (cloud + both onprems) swap this for the real
 * compaction pass via the next.config `resolveAlias` (`@/ee/policy-compact`);
 * instrumentation calls the seam unconditionally and each impl self-gates on
 * the editing flag.
 */
export const runPolicyCompaction = async (): Promise<void> => {};
