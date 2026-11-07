import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { auth, authMiddleware, requireWorkspaceId } from "../middleware/auth";
import { ServiceError } from "../services/errors";
import {
  getAgentRuntimeUsage,
  getOrgRuntimeUsage,
} from "../services/runtime-usage-service";
import { usageWindowSchema } from "../validations/usage";

/**
 * RUNTIME USAGE (awake time), read-only and unaudited like every list read:
 * one agent's at `GET /v1/agents/:agentId/usage` (composed onto /agents like
 * runs and memories), the org's at `GET /v1/usage/runtime`. Both take an
 * optional `?from&to` window (ISO), defaulting to all time.
 */

const parseWindow = (query: Record<string, string>) => {
  const parsed = usageWindowSchema.safeParse(query);
  if (!parsed.success) {
    throw new ServiceError(
      "UNPROCESSABLE",
      parsed.error.issues[0]?.message ?? "Invalid window",
    );
  }
  return parsed.data;
};

/** One agent's awake time, for the agent page. Workspace member. */
export const agentUsageRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);
  app.get("/:agentId/usage", async (c) => {
    const a = c.get("auth");
    return c.json(
      await getAgentRuntimeUsage(
        requireWorkspaceId(a),
        a.organizationId,
        c.req.param("agentId"),
        parseWindow(c.req.query()),
      ),
    );
  });
  return app;
};

/**
 * The org's awake time per agent, for the org usage page. Org admin, no
 * workspace: the page is an org surface and the numbers span every
 * workspace. Middleware is per-handler, not `use("*")`, because this router
 * mounts under /usage and Hono copies a wildcard `use` onto the parent.
 */
export const usageRoutes = () => {
  const app = new Hono<ApiEnv>();
  const admin = auth({ requireWorkspace: false, role: "admin" });
  app.get("/runtime", admin, async (c) => {
    const a = c.get("auth");
    return c.json(
      await getOrgRuntimeUsage(a.organizationId, parseWindow(c.req.query())),
    );
  });
  return app;
};
