import { Hono, type Context } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware, requireWorkspaceId } from "../middleware/auth";
import { apiError } from "../middleware/error-handler";
import { ServiceError } from "../services/errors";
import {
  createSkill,
  deleteSkill,
  getSkill,
  importAgentSkills,
  listSkillsForWorkspace,
  updateSkill,
} from "../services/skill-service";
import {
  createSkillSchema,
  MAX_SKILL_ZIP_BYTES,
  updateSkillSchema,
} from "../validations/skills";
import { readCappedBinaryBody } from "@onecli/channels";
import { importSkillZip, type SkillZipResult } from "../services/skill-import";
import { ZipError } from "../lib/zip";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../services/audit-service";

/**
 * The workspace door of the skills surface (step 9): /v1/skills. Lists the
 * skills that REACH this workspace — its agents' own rows plus the org's
 * (org rows read-only here; they are managed on /v1/org/skills) — and
 * creates agent-tier rows only (`agentId` required). Own mount, not composed
 * onto /agents: the list spans the workspace's agents plus the org tier.
 *
 * `recordAuditEvent`, never `withAudit`: the gateway reads no skill table
 * (the cron/memory rule).
 */

const parseBody = async (raw: Request) =>
  await raw
    .clone()
    .json()
    .catch(() => null);

/** Folder problems named in a refusal; the rest are counted. */
const MAX_PROBLEMS_SHOWN = 5;

/**
 * Read an uploaded skill zip (capped mid-stream) and unpack it: the skills
 * to save, or the response to send instead (413 past the cap; 422 for an
 * empty or unreadable upload, a damaged zip, or one with nothing to import,
 * naming each folder's problem).
 */
export const readSkillZipUpload = async (
  c: Context<ApiEnv>,
): Promise<SkillZipResult | Response> => {
  const body = await readCappedBinaryBody(c.req.raw, MAX_SKILL_ZIP_BYTES);
  if (!body.ok) {
    if (body.reason === "too_large") {
      return c.json(
        apiError(
          `Skill zips are capped at ${MAX_SKILL_ZIP_BYTES / (1024 * 1024)} MB.`,
        ),
        413,
      );
    }
    throw new ServiceError(
      "UNPROCESSABLE",
      body.reason === "empty" ? "The upload is empty" : "Unreadable upload",
    );
  }
  let read: SkillZipResult;
  try {
    read = await importSkillZip(body.bytes);
  } catch (err) {
    if (err instanceof ZipError) {
      throw new ServiceError("UNPROCESSABLE", err.message);
    }
    throw err;
  }
  if (read.skills.length === 0) {
    const shown = read.problems.slice(0, MAX_PROBLEMS_SHOWN);
    const more = read.problems.length - shown.length;
    throw new ServiceError(
      "UNPROCESSABLE",
      `Nothing to import: ${shown
        .map((p) => `${p.folder || "the zip"} (${p.reason})`)
        .join("; ")}${more > 0 ? `; and ${more} more` : ""}`,
    );
  }
  return read;
};

export const userSkillRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // POST /skills/import?agentId=: a skill zip (one or several skills) into
  // one hosted agent. The body is the raw zip. A name the agent already
  // holds is replaced.
  app.post("/import", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.query("agentId")?.trim();
    if (!agentId) {
      throw new ServiceError("UNPROCESSABLE", "agentId is required");
    }
    const read = await readSkillZipUpload(c);
    if (read instanceof Response) return read;
    const imported = await importAgentSkills(
      workspaceId,
      agentId,
      read.skills,
      { userId: a.userId, email: a.userEmail },
    );
    for (const skill of imported) {
      await recordAuditEvent({
        workspaceId,
        userId: a.userId,
        userEmail: a.userEmail,
        action: skill.replaced ? AUDIT_ACTIONS.UPDATE : AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.SKILL,
        source: AUDIT_SOURCE.API,
        metadata: {
          skillId: skill.id,
          name: skill.name,
          agentId,
          files: String(skill.files),
          source: "zip",
        },
      });
    }
    return c.json({ imported, problems: read.problems }, 201);
  });

  // GET /skills — the section's payload: metadata only, bodies per detail
  // fetch (a full list of 32k-char bodies would be a heavy payload).
  app.get("/", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    return c.json({
      skills: await listSkillsForWorkspace(workspaceId, a.organizationId),
    });
  });

  // POST /skills — always an agent's own skill (agentId required).
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
        agentId: body.data.agentId,
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
