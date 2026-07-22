/**
 * Policy v2 runtime flags — the single source of truth for "is v2 policy editing
 * live on this deployment". Pure and dependency-free (reads only `process.env`
 * plus the pure edition parser), so it is safe to import from routes,
 * middleware, or a standalone startup entry.
 */
import { parseEdition } from "./edition";

/**
 * Whether v2 policy EDITING is enabled.
 *
 * An explicit `POLICY_EDITING_ENABLED` always wins ("1"/"true" on, anything
 * else off — the operator kill-switch/rollback). Unset resolves by edition
 * (step 9.5, release-as-cutover): ON for every non-cloud edition — OSS and
 * onprem ship cut over, with the boot migrator materializing v2 before the
 * editor is reachable — and OFF for cloud, whose deploys set the flag
 * explicitly (the step-5 phased flip).
 */
export const policyEditingEnabled = (): boolean => {
  const v = process.env.POLICY_EDITING_ENABLED;
  if (v !== undefined) return v === "1" || v === "true";
  return runtimeEdition() !== "cloud";
};

const runtimeEdition = () =>
  parseEdition(process.env.EDITION ?? process.env.NEXT_PUBLIC_EDITION).edition;

/** Whether this runtime is the OSS edition — used by the shared policy
 * service to phrase capability rejections as OneCLI Cloud pointers there
 * (byte-identical messages everywhere else). */
export const isOssEdition = (): boolean => runtimeEdition() === "oss";

/**
 * Rejection message for a legacy old-model custom-rule write made while v2
 * editing is live: the gateway now reads `policy_rules_v2`, so an old-model write
 * would never be enforced. Points callers at the v2 policy API.
 */
export const LEGACY_RULE_WRITE_DEPRECATION =
  "Custom policy rules are now managed through the policy API (/v1/policy). This " +
  "deployment enforces the v2 policy engine, so writes to the legacy rules " +
  "endpoint are no longer applied — update your CLI/SDK to author rules via /v1/policy.";

/**
 * Rejection message for a legacy app-permission write (`PUT /permissions/:provider`)
 * made while v2 editing is live. Post-adoption the coherence bridge no longer
 * re-derives app-permission rows from the old model (they were adopted as
 * user-owned `custom` rules), so an old-model permission write would be a silent
 * no-op — rejected instead, pointing at the policy console / API.
 */
export const LEGACY_APP_PERMISSION_WRITE_DEPRECATION =
  "App permissions are now managed as policy rules (the Policy console, or " +
  "/v1/policy). This deployment enforces the v2 policy engine and has adopted the " +
  "app-permission rules as editable policy rules, so writes to the legacy " +
  "permissions endpoint are no longer applied.";

/**
 * The sources the coherence bridge treats as DERIVED from the old model —
 * deleted and re-derived on every rematerialization. Everything else
 * (non-default) is KEPT verbatim; keep-filters must be expressed as the
 * complement (`source NOT IN bridgeDerivedSources()`) so the kept and derived
 * partitions can never disagree.
 *
 * At `POLICY_EDITING_ENABLED=1` (post-adoption) `app_permission` rows are
 * user-owned — the boot adoption pass re-tags them `custom`, and any straggler
 * still tagged `app_permission` is preserved verbatim (never deleted, never
 * re-derived) until the next adoption run re-tags it. At editing-off (OSS and
 * pre-cutover cloud) the old model stays authoritative and the full derived set
 * is unchanged.
 */
export const bridgeDerivedSources = (): string[] =>
  policyEditingEnabled()
    ? ["blocklist", "equipment"]
    : ["app_permission", "blocklist", "equipment"];
