import { Hono } from "hono";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { cloudOnly } from "../middleware/cloud-only";
import { notifyDiscord } from "../notifications/discord";

export const reviewerRoutes = () => {
  const app = new Hono<ApiEnv>();

  // Hosted-ops plumbing (Discord login notifications for app-review
  // accounts): edition-dark on self-host.
  app.use("*", cloudOnly);

  app.post("/login-notify", auth({ requireWorkspace: false }), async (c) => {
    const authCtx = c.get("auth");

    const countryCode = c.req.header("cloudfront-viewer-country") ?? undefined;
    const country = c.req.header("cloudfront-viewer-country-name") ?? undefined;

    notifyDiscord("reviewer_login", {
      email: authCtx.userEmail,
      countryCode,
      country,
    });

    return c.json({ status: "OK" });
  });

  return app;
};
