import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "../types";
import { ServiceError } from "../services/errors";
import {
  policyEditingEnabled,
  LEGACY_APP_PERMISSION_WRITE_DEPRECATION,
  LEGACY_RULE_WRITE_DEPRECATION,
} from "../lib/policy-flags";

/**
 * Rejects legacy old-model **custom-rule writes** once v2 policy editing is live.
 *
 * When v2 is enforced the gateway reads `policy_rules_v2`, so a write to the
 * legacy `/v1/rules` (or `/v1/org/rules`) custom-rule endpoints would land only
 * in the old model and never reach the gateway — a silent no-op. Fail loud with
 * `410 Gone` and point callers at `/v1/policy`.
 *
 * Attach to the custom-rule write routes — `POST /`, `PATCH /:ruleId`,
 * `DELETE /:ruleId`. Inert until `POLICY_EDITING_ENABLED` is set, which OSS
 * never does — so OSS keeps its full legacy write surface until its own cutover.
 */
export const denyLegacyRuleWriteWhenV2: MiddlewareHandler<ApiEnv> = async (
  c,
  next,
) => {
  if (policyEditingEnabled()) {
    throw new ServiceError("GONE", LEGACY_RULE_WRITE_DEPRECATION);
  }
  return next();
};

/**
 * Rejects the legacy **app-permission write** (`PUT /permissions/:provider`,
 * project + org variants) once v2 policy editing is live.
 *
 * Pre-adoption this write stayed open (the coherence bridge re-materialized it
 * into v2). At the editing cutover the app-permission rules were ADOPTED as
 * user-owned `custom` policy rules and the bridge stopped re-deriving them —
 * so an old-model permission write would be a silent no-op. Fail loud instead
 * and point callers at the Policy console / `/v1/policy`. Reads (`GET
 * /permissions/:provider`) stay open over the frozen old model. Inert until
 * `POLICY_EDITING_ENABLED` is set (OSS unaffected).
 */
export const denyLegacyAppPermissionWriteWhenV2: MiddlewareHandler<
  ApiEnv
> = async (c, next) => {
  if (policyEditingEnabled()) {
    throw new ServiceError("GONE", LEGACY_APP_PERMISSION_WRITE_DEPRECATION);
  }
  return next();
};
