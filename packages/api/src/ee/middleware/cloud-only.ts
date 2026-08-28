import { createMiddleware } from "hono/factory";
import { IS_CLOUD } from "../../lib/env";

/**
 * Blanket EDITION gate for hosted-platform routers — the surfaces that exist
 * only because OUR accounts talk to them (Resend and Stripe webhook intake,
 * Discord operator notifications for app-review logins). Mounted as
 * `app.use("*", cloudOnly)` at the top of such a router so the whole surface
 * is absent off cloud.
 *
 * A 404, not a 403: on a self-host these endpoints do not exist at all, and
 * saying so leaks nothing about what cloud runs. Distinct from
 * `requireEnterprise` (a licensed FEATURE the deployment could buy) and from
 * config-darkness (a cloud surface whose secret is not set yet) — those still
 * apply behind this gate on cloud.
 *
 * Env-agnostic on purpose: it touches only the response, so it mounts on
 * routers of any Hono env.
 */
export const cloudOnly = createMiddleware(async (c, next) => {
  if (!IS_CLOUD) {
    return c.json(
      {
        error: {
          message: "Not available on this deployment",
          type: "invalid_request_error",
        },
      },
      404,
    );
  }
  await next();
});
