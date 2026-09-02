import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { auth } from "../middleware/auth";
import { CAPS } from "../lib/env";
import { ServiceError } from "../services/errors";
import {
  createOrgSkill,
  deleteOrgSkill,
  getOrgSkill,
  listOrgSkills,
  updateOrgSkill,
} from "../services/skill-service";
import { createOrgSkillSchema, updateSkillSchema } from "../validations/skills";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../services/audit-service";

/**
 * The org door of the skills surface (step 9): /v1/org/skills — a FREE
 * surface (skills are Apache-side; never ee/). Reads are member-level (the
 * rows land in every member's workspace view anyway); writes are org-admin
 * where roles exist (the runners.ts posture — with RBAC off there is no role
 * resolver and membership is the only fence).
 */

const parseBody = async (raw: Request) =>
  await raw
    .clone()
    .json()
    .catch(() => null);

export const orgSkillRoutes = () => {
  const app = new Hono<ApiEnv>();
  const member = auth({ requireWorkspace: false });
  const admin = CAPS.rbac
    ? auth({ requireWorkspace: false, role: "admin" })
    : auth({ requireWorkspace: false });

  // GET /org/skills
  app.get("/", member, async (c) => {
    const a = c.get("auth");
    return c.json({ skills: await listOrgSkills(a.organizationId) });
  });

  // POST /org/skills
  app.post("/", admin, async (c) => {
    const a = c.get("auth");
    const body = createOrgSkillSchema.safeParse(await parseBody(c.req.raw));
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        body.error.issues[0]?.message ?? "Invalid body",
      );
    }
    const skill = await createOrgSkill(a.organizationId, body.data, {
      userId: a.userId,
      email: a.userEmail,
    });
    await recordAuditEvent({
      organizationId: a.organizationId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.SKILL,
      source: AUDIT_SOURCE.API,
      metadata: { skillId: skill.id, name: skill.name, scope: skill.scope },
    });
    return c.json(skill, 201);
  });

  // GET /org/skills/:skillId
  app.get("/:skillId", member, async (c) => {
    const a = c.get("auth");
    return c.json(await getOrgSkill(a.organizationId, c.req.param("skillId")));
  });

  // PATCH /org/skills/:skillId
  app.patch("/:skillId", admin, async (c) => {
    const a = c.get("auth");
    const skillId = c.req.param("skillId");
    const body = updateSkillSchema.safeParse(await parseBody(c.req.raw));
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        body.error.issues[0]?.message ?? "Invalid body",
      );
    }
    const skill = await updateOrgSkill(a.organizationId, skillId, body.data);
    await recordAuditEvent({
      organizationId: a.organizationId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.SKILL,
      source: AUDIT_SOURCE.API,
      metadata: { skillId, fields: Object.keys(body.data) },
    });
    return c.json(skill);
  });

  // DELETE /org/skills/:skillId
  app.delete("/:skillId", admin, async (c) => {
    const a = c.get("auth");
    const skillId = c.req.param("skillId");
    await deleteOrgSkill(a.organizationId, skillId);
    await recordAuditEvent({
      organizationId: a.organizationId,
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
