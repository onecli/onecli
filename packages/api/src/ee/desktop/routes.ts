/**
 * The agent's hosted desktop: what the Computer section reads, the wake,
 * and the control lease. Resource-shaped under `/agents/:agentId/desktop`:
 * the control lease is a sub-resource a person creates (take) and deletes
 * (hand back). Three-segment paths, so the agents router's single-segment
 * routes never shadow them.
 *
 * Hosted platform only: off cloud every path here is absent (`cloudOnly`,
 * an edition-dark 404). On cloud every route runs with the person's own
 * session and the workspace header (`requireWorkspaceId`): the service
 * fences the agent to that workspace (not-found shaped) and the lease to
 * the caller. The control host is returned only to the lease holder, and
 * only the relay's ticket check decides who may actually connect to it.
 */

import { Hono } from "hono";
import type { ApiEnv } from "../../types";
import { authMiddleware, requireWorkspaceId } from "../../middleware/auth";
import { cloudOnly } from "../middleware/cloud-only";
import {
  desktopFor,
  releaseControl,
  takeControl,
  wakeDesktop,
} from "./service";

export const agentDesktopRoutes = () => {
  const app = new Hono<ApiEnv>();
  // Scoped to THIS router's paths: it is composed onto the shared /agents
  // base, so a "*" middleware would gate every /v1/agents/:id/* request.
  // The bare path and the subpaths are both this router's.
  for (const own of ["/:agentId/desktop", "/:agentId/desktop/*"]) {
    app.use(own, cloudOnly);
    app.use(own, authMiddleware);
  }

  // GET /agents/:agentId/desktop — the section's payload, for this viewer.
  app.get("/:agentId/desktop", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    return c.json(
      await desktopFor(workspaceId, c.req.param("agentId"), a.userId),
    );
  });

  // POST /agents/:agentId/desktop/wake — start the sandbox so there is a
  // screen to look at. 202 because the boot is asynchronous; the body is
  // the state as it now stands (`waking`), so the section moves on the same
  // tick and the poll takes it from there.
  app.post("/:agentId/desktop/wake", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    await wakeDesktop(workspaceId, agentId);
    return c.json(await desktopFor(workspaceId, agentId, a.userId), 202);
  });

  // POST /agents/:agentId/desktop/control — take the lease. 409 when
  // someone else holds it (the message names them).
  app.post("/:agentId/desktop/control", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    return c.json(
      await takeControl(workspaceId, c.req.param("agentId"), {
        userId: a.userId,
        userEmail: a.userEmail,
        organizationId: a.organizationId,
      }),
    );
  });

  // DELETE /agents/:agentId/desktop/control — hand the desktop back (the
  // person's Stop). A pending ask is settled and the agent resumes.
  app.delete("/:agentId/desktop/control", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    return c.json(
      await releaseControl(workspaceId, c.req.param("agentId"), {
        userId: a.userId,
        userEmail: a.userEmail,
        organizationId: a.organizationId,
      }),
    );
  });

  return app;
};
