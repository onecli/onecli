import { createHash, timingSafeEqual } from "node:crypto";

import { createMiddleware } from "hono/factory";

import { PREVIEW_RELAY_SECRET } from "../lib/env";

/**
 * Static-secret auth for the preview relay's control-plane channel
 * (plans/sandbox-ports.md §11.3). The terminator-auth shape exactly: its own
 * header and its own secret, authorizing `/v1/preview-relay/*` and nothing
 * else. sha256-then-timingSafeEqual; unset secret = the surface refuses
 * everything (dark, fail-closed).
 */

const digest = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();

export const previewRelayAuth = createMiddleware(async (c, next) => {
  const provided = c.req.header("x-preview-relay-secret");
  if (
    !PREVIEW_RELAY_SECRET ||
    !provided ||
    !timingSafeEqual(digest(provided), digest(PREVIEW_RELAY_SECRET))
  ) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});
