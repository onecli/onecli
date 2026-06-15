/**
 * Shared-secret guard for the internal gateway↔Node endpoints.
 *
 * The gateway presents `X-Gateway-Secret`; we compare it (timing-safe) to
 * `GATEWAY_INTERNAL_SECRET`. This is abuse-prevention, not the secret boundary:
 * the 1Password token is supplied per request, so a caller can only resolve
 * secrets it already holds a token for.
 */
import { timingSafeEqual } from "node:crypto";

import { createMiddleware } from "hono/factory";

import { GATEWAY_INTERNAL_SECRET } from "../lib/env";
import type { ApiEnv } from "../types";

const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

export const internalAuth = createMiddleware<ApiEnv>(async (c, next) => {
  const provided = c.req.header("X-Gateway-Secret") ?? "";
  if (
    !GATEWAY_INTERNAL_SECRET ||
    !safeEqual(provided, GATEWAY_INTERNAL_SECRET)
  ) {
    return c.json(
      { error: { message: "unauthorized", type: "authentication_error" } },
      401,
    );
  }
  await next();
});
