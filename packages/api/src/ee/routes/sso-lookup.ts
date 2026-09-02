import { Hono } from "hono";
import { requireEnterprise } from "../middleware/enterprise-gate";
import type { ApiEnv } from "../../types";
import { clientIpKey, rateLimit } from "../middleware/rate-limit";
import { ssoLookupSchema } from "../validations/sso-lookup";
import { lookupSsoForEmail } from "../sso/sso-trust";

/**
 * Public home-realm discovery for the login page (no auth — it runs before
 * any session exists). POST keeps the email out of URL/access logs. The
 * response reveals only the domain→SSO mapping (like every email-first SSO
 * login), never whether a user exists — the shape is identical either way.
 */
export const ssoLookupRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", requireEnterprise("sso"));

  const throttle = rateLimit({
    name: "sso-lookup",
    limit: 20,
    windowSeconds: 60,
    key: clientIpKey,
  });

  app.post("/lookup", throttle, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ssoLookupSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const match = await lookupSsoForEmail(parsed.data.email);
    if (!match) return c.json({ sso: false as const });
    return c.json({
      sso: true as const,
      provider: match.provider,
      enforced: match.enforced,
    });
  });

  return app;
};
