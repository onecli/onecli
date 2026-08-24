import { createHash, timingSafeEqual } from "node:crypto";

import { createMiddleware } from "hono/factory";

import { SSH_TERMINATOR_SECRET } from "../lib/env";

/**
 * Static-secret auth for the SSH terminator's control-plane channel
 * (plans/sandbox-platform.md step 5, §3.8's narrow terminator↔control-plane
 * credential). Deliberately its own middleware and its own secret — the
 * one-credential-per-plane law: this value authorizes `/v1/ssh-terminator/*`
 * and NOTHING else; no other family passes here, and this secret passes
 * nowhere else. It is a service-to-service secret (the
 * GATEWAY_INTERNAL_SECRET shape), never a DB-backed token family.
 *
 * sha256-then-timingSafeEqual (the sandbox-manager's auth middleware
 * pattern): hashing first removes even the length branch as a timing signal.
 * Unset secret = the surface refuses everything — dark, fail-closed.
 */

const unauthorized = { error: "Unauthorized" } as const;

const digest = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();

export const terminatorAuth = createMiddleware(async (c, next) => {
  const provided = c.req.header("x-terminator-secret");
  if (
    !SSH_TERMINATOR_SECRET ||
    !provided ||
    !timingSafeEqual(digest(provided), digest(SSH_TERMINATOR_SECRET))
  ) {
    return c.json(unauthorized, 401);
  }
  await next();
});
