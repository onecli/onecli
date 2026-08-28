import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { auth } from "../middleware/auth";
import { CAPS } from "../lib/env";
import { listRunners } from "../services/runner-service";

/**
 * GET /v1/runners — the operator's view of the compute plane: which runners
 * exist and whether they are alive. Read-only; runners are created by
 * registering (§5.1), never through this surface.
 *
 * Deployment-scoped rather than workspace-scoped (one runner serves the whole
 * install in v2), which is exactly why it is **admin-only**: names are
 * operator-chosen and usually hostnames, and `sandboxCount` is a
 * deployment-wide total, so on a multi-org install an ordinary member of one
 * org would otherwise learn about every other org's fleet usage. The people
 * who need this are the people who can restart the runner.
 *
 * It carries no workspace, agent, or credential detail either way — the token
 * column is never even selected.
 *
 * The admin requirement applies only where roles exist. With RBAC off there is
 * no role resolver at all, so asking for one would 403 every caller including
 * the owner — and a deployment without roles is one where every API-key holder
 * is already an operator. Same posture as the rest of the onprem surface.
 */
export const runnersRoutes = () => {
  const app = new Hono<ApiEnv>();

  const guard = CAPS.rbac
    ? auth({ requireWorkspace: false, role: "admin" })
    : auth({ requireWorkspace: false });

  app.get("/", guard, async (c) => c.json({ runners: await listRunners() }));

  return app;
};
