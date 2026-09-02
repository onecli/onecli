import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware, requireWorkspaceId } from "../middleware/auth";
import { ServiceError } from "../services/errors";
import {
  createSkill,
  deleteSkill,
  getSkill,
  listSkillsForWorkspace,
  updateSkill,
} from "../services/skill-service";
import { createSkillSchema, updateSkillSchema } from "../validations/skills";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../services/audit-service";

/**
 * The workspace door of the skills surface (step 9): /v1/skills. Lists every
 * tier that REACHES this workspace (org rows read-only here — they are managed
 * on /v1/org/skills); creates workspace- or agent-tier rows. Own mount,
 * deliberately not composed onto /agents: two of three tiers have no agent.
 *
 * `recordAuditEvent`, never `withAudit`: the gateway reads no skill table
 * (the cron/memory rule).
 */

const parseBody = async (raw: Request) =>
  await raw
    .clone()
    .json()
    .catch(() => null);

export const userSkillRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // GET /skills — the section's payload: metadata only, bodies per detail
  // fetch (50 × 32k would be a heavy list).
  app.get("/", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    return c.json({
      skills: await listSkillsForWorkspace(workspaceId, a.organizationId),
    });
  });

  // POST /skills — workspace tier, or agent tier when agentId is present.
  app.post("/", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const body = createSkillSchema.safeParse(await parseBody(c.req.raw));
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        body.error.issues[0]?.message ?? "Invalid body",
      );
    }
    const skill = await createSkill(workspaceId, body.data, {
      userId: a.userId,
      email: a.userEmail,
    });
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.SKILL,
      source: AUDIT_SOURCE.API,
      metadata: {
        skillId: skill.id,
        name: skill.name,
        scope: skill.scope,
        ...(skill.agentId && { agentId: skill.agentId }),
      },
    });
    return c.json(skill, 201);
  });

  // GET /skills/:skillId — the full view, files inline.
  app.get("/:skillId", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    return c.json(
      await getSkill(workspaceId, a.organizationId, c.req.param("skillId")),
    );
  });

  // PATCH /skills/:skillId — description/content/enabled/files; `name` is
  // immutable (the directory name). Org rows answer FORBIDDEN with a pointer.
  app.patch("/:skillId", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const skillId = c.req.param("skillId");
    const body = updateSkillSchema.safeParse(await parseBody(c.req.raw));
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        body.error.issues[0]?.message ?? "Invalid body",
      );
    }
    const skill = await updateSkill(
      workspaceId,
      a.organizationId,
      skillId,
      body.data,
    );
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.SKILL,
      source: AUDIT_SOURCE.API,
      metadata: { skillId, fields: Object.keys(body.data) },
    });
    return c.json(skill);
  });

  // DELETE /skills/:skillId
  app.delete("/:skillId", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const skillId = c.req.param("skillId");
    await deleteSkill(workspaceId, a.organizationId, skillId);
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.SKILL,
      source: AUDIT_SOURCE.API,
      metadata: { skillId },
    });
    return c.body(null, 204);
  });

  return app;
};
