import { getPolicyCoherenceBridge } from "../providers";
import { logger } from "../lib/logger";
import type { ResourceScope } from "./resource-scope";

/**
 * Best-effort: re-materialize the scope's bridge-DERIVED v2 rules after an
 * OLD-model write, so the v2-reading gateway stays current (step-5 coherence
 * bridge; OSS no-op, retired step 10). The derived set is `bridgeDerivedSources()`
 * — blocklist + equipment, plus app_permission pre-cutover (at
 * `POLICY_EDITING_ENABLED=1` the app-permission rules are adopted as user-owned
 * customs and their legacy write 410s, so only blocklist/equipment writes still
 * flow here).
 *
 * Best-effort + self-healing: a failure is logged, not thrown — it must not fail
 * the user's primary write, and the NEXT bridged write re-materializes the whole
 * scope. Inert until `POLICY_ENFORCE_V2` is flipped on (the gateway ignores v2
 * while off).
 */
export const notifyPolicyCoherence = async (
  scope: ResourceScope,
): Promise<void> => {
  try {
    await getPolicyCoherenceBridge().rematerialize(scope);
  } catch (err) {
    logger.warn({ err, scope }, "policy coherence bridge failed");
  }
};
