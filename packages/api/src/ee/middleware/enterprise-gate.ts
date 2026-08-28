import { createMiddleware } from "hono/factory";
import { isEntitled } from "../../lib/entitlements";
import { enterpriseLicenseMessage } from "../../lib/entitlements-guard";
import type { EnterpriseFeature } from "../../lib/entitlements";

/**
 * Blanket entitlement gate for wholly-enterprise routers. Mounted as
 * `app.use("*", requireEnterprise("<feature>"))` at the top of each EE
 * router so the entire surface — reads, writes, and deletes alike — is dark
 * without a license (the decided posture: no EE behavior is left over when
 * the flag is off, even where the data still exists). Cloud always passes;
 * plan gating there is a separate dial the routers keep. Env-agnostic on
 * purpose: it touches only the response, so it mounts on routers of any
 * Hono env.
 */
export const requireEnterprise = (feature: EnterpriseFeature) =>
  createMiddleware(async (c, next) => {
    if (!isEntitled()) {
      return c.json(
        {
          error: {
            message: enterpriseLicenseMessage(feature),
            type: "enterprise_license_required",
          },
        },
        403,
      );
    }
    await next();
  });
