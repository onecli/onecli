import type { ResourceScope } from "../../services/resource-scope";

// ── Policy coherence bridge seam (step-5 cutover, retired step 10) ───────────
// The gateway reads v2; old-model writes still flow through their legacy
// editors/APIs. After such a write, the EE editions re-materialize the scope's
// bridge-DERIVED v2 rules (`bridgeDerivedSources()`: blocklist + equipment —
// plus app_permission pre-cutover; at POLICY_EDITING_ENABLED=1 the
// app-permission rules are adopted as user-owned customs and their legacy write
// 410s) so the v2-reading gateway stays current. OSS default is a no-op (OSS
// keeps the old model until its own cutover, step 9.5); the cloud edition
// injects the real bridge via `createApiApp`, like the other seams.

export interface PolicyCoherenceBridge {
  /** Re-materialize the scope's bridge-derived v2 rules (`bridgeDerivedSources`)
   * from their live sources and publish. Best-effort at the call site. */
  rematerialize(scope: ResourceScope): Promise<void>;
}

const defaultPolicyCoherenceBridge: PolicyCoherenceBridge = {
  rematerialize: async () => {},
};

let _policyCoherenceBridge: PolicyCoherenceBridge =
  defaultPolicyCoherenceBridge;

export const initPolicyCoherenceBridge = (b: PolicyCoherenceBridge) => {
  _policyCoherenceBridge = b;
};

export const getPolicyCoherenceBridge = (): PolicyCoherenceBridge =>
  _policyCoherenceBridge;
