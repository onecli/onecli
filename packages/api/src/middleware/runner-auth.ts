import { createMiddleware } from "hono/factory";
import { db } from "@onecli/db";
import { logger } from "../lib/logger";

const log = logger.child({ component: "runner-auth" });

/**
 * Bearer auth for the `rnr_` token family — the runner daemon's credential
 * (plans/hosted-agents-v2.md §5.1). Deliberately its own narrow middleware:
 * an `rnr_` token authorizes `/v1/runner/*` and NOTHING else, and no other
 * family passes here (an `oc_` key or session hits the same hint-free 401).
 * Widening either direction is a security regression, and both are tested.
 *
 * Modeled on the SCIM middleware (`ee/scim/auth.ts`): own context variable,
 * hint-free 401 that never distinguishes missing vs unknown tokens, and a
 * fire-and-forget liveness touch — every authenticated runner call refreshes
 * `lastSeenAt`, so the poll loop itself is the heartbeat.
 */

export interface RunnerAuthContext {
  runnerId: string;
  name: string;
}

export type RunnerEnv = { Variables: { runner: RunnerAuthContext } };

const unauthorized = { error: "Unauthorized" } as const;

export const runnerAuth = createMiddleware<RunnerEnv>(async (c, next) => {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token || !token.startsWith("rnr_")) {
    return c.json(unauthorized, 401);
  }

  const runner = await db.runner.findUnique({
    where: { token },
    select: { id: true, name: true },
  });
  if (!runner) return c.json(unauthorized, 401);

  c.set("runner", { runnerId: runner.id, name: runner.name });

  // Liveness rides every call; a failed touch must never fail the request.
  db.runner
    .update({ where: { id: runner.id }, data: { lastSeenAt: new Date() } })
    .catch((err: unknown) => {
      log.warn({ err, runnerId: runner.id }, "runner lastSeenAt touch failed");
    });

  await next();
});
