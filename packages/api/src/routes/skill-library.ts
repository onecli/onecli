import { Hono } from "hono";
import { z } from "zod";
import type { ApiEnv } from "../types";
import { auth, authMiddleware, requireWorkspaceId } from "../middleware/auth";
import { ServiceError } from "../services/errors";
import {
  LibraryReplaceConflict,
  attachLibrarySkill,
  connectSkillSource,
  detachLibrarySkill,
  disconnectSkillSource,
  discoverLibrarySkills,
  getSkillSource,
  listLibraryAccessRepos,
  listLibraryGitHubAccounts,
  listLibrarySkillsForAgent,
  requireHostedAgentInWorkspace,
  resyncLibrarySkill,
  setAgentLibrarySkillEnabled,
} from "../services/skill-library-service";
import {
  LIBRARY_SKILL_NAME_MAX,
  LIBRARY_SKILL_NAME_PATTERN,
} from "../apps/github-skill-repo";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../services/audit-service";

/**
 * The skill library. Two doors:
 *
 * - /v1/org/skill-library: the org's connected repo (admin writes), the live
 *   repo listing (preview), and a per-skill re-sync.
 * - /v1/agents/:agentId/library-skills: one agent's library skills, the live
 *   listing marked with what it has, add/remove, and its on/off switch.
 *   Every one of them is fenced to the caller's workspace first.
 *
 * Free surface (never ee/), like skills. Audited via recordAuditEvent: the
 * gateway reads no skill table.
 */

const parseBody = async (raw: Request) =>
  await raw
    .clone()
    .json()
    .catch(() => null);

/** One GitHub access source at most: an org connection, a fresh skills-only
 * grant, or neither (keep the library's current access). */
const accessShape = {
  appConnectionId: z.string().trim().min(1).max(100).optional(),
  grant: z.string().trim().min(1).max(4000).optional(),
};
const oneAccess = (v: { appConnectionId?: string; grant?: string }) =>
  !(v.appConnectionId && v.grant);
const ONE_ACCESS = "Send a GitHub connection or a skills-only grant, not both";

const connectSchema = z
  .object({
    ...accessShape,
    repo: z.string().trim().min(3).max(200),
    branch: z.string().trim().min(1).max(200).optional(),
    /** Confirms dropping the skills agents use from the old repo or branch. */
    replace: z.boolean().optional(),
  })
  .strict()
  .refine(oneAccess, ONE_ACCESS);

const accessReposSchema = z
  .object(accessShape)
  .strict()
  .refine(oneAccess, ONE_ACCESS);

const enabledSchema = z.object({ enabled: z.boolean() }).strict();

/** Path parameter: a skill name as the standard writes it. Malformed input
 * is a 422, like every body refusal here. */
const skillName = (raw: string): string => {
  if (
    raw.length > LIBRARY_SKILL_NAME_MAX ||
    !LIBRARY_SKILL_NAME_PATTERN.test(raw)
  ) {
    throw new ServiceError("UNPROCESSABLE", "Invalid skill name");
  }
  return raw;
};

const parsed = <T>(result: z.ZodSafeParseResult<T>): T => {
  if (!result.success) {
    throw new ServiceError(
      "UNPROCESSABLE",
      result.error.issues[0]?.message ?? "Invalid body",
    );
  }
  return result.data;
};

export const orgSkillLibraryRoutes = () => {
  const app = new Hono<ApiEnv>();
  const member = auth({ requireWorkspace: false });
  // Same door as /org/apps: an admin where roles are enforced, any ACTIVE
  // member on a flat team (a suspended member's API key is refused).
  const admin = auth({ requireWorkspace: false, role: "admin" });

  // GET /org/skill-library — the connected repo (or null) and what it is
  // used for (what a switch or disconnect would take away).
  app.get("/", member, async (c) => {
    const a = c.get("auth");
    return c.json(await getSkillSource(a.organizationId));
  });

  // PUT /org/skill-library — connect, or switch the repo or branch. A switch
  // that drops skills agents use is a 409 with the impact unless the body
  // confirms it with `replace: true`.
  app.put("/", admin, async (c) => {
    const a = c.get("auth");
    const body = parsed(connectSchema.safeParse(await parseBody(c.req.raw)));
    const { appConnectionId, grant, repo, branch, replace } = body;
    let source;
    try {
      source = await connectSkillSource(
        a.organizationId,
        {
          ...(appConnectionId ? { appConnectionId } : grant ? { grant } : {}),
          repo,
          ...(branch ? { branch } : {}),
          ...(replace ? { replace } : {}),
        },
        { userId: a.userId, email: a.userEmail },
      );
    } catch (err) {
      if (!(err instanceof LibraryReplaceConflict)) throw err;
      // The one structured refusal here: the client confirms with the
      // impact it names (`details`), then retries with `replace: true`.
      return c.json(
        {
          error: {
            code: "replace_required",
            message: err.message,
            type: "invalid_request_error",
            details: err.usage,
          },
        },
        409,
      );
    }
    await recordAuditEvent({
      organizationId: a.organizationId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.SKILL_LIBRARY,
      source: AUDIT_SOURCE.API,
      metadata: {
        repo: source.repo,
        branch: source.branch,
        installationId: source.installationId,
        // Never the grant itself: where the access came from, by kind.
        access: appConnectionId
          ? "org_connection"
          : grant
            ? "skills_only_install"
            : "unchanged",
        ...(replace ? { replaced: "true" } : {}),
      },
    });
    return c.json(source);
  });

  // GET /org/skill-library/github-accounts — the org-level GitHub accounts
  // the library may reuse (admins pick one in the connect dialog).
  app.get("/github-accounts", admin, async (c) => {
    const a = c.get("auth");
    return c.json(await listLibraryGitHubAccounts(a.organizationId));
  });

  // POST /org/skill-library/access/repositories — the repos the connect
  // dialog may pick from, for an org connection, a fresh skills-only grant,
  // or the library's current access. POST: a grant is too private for a URL.
  app.post("/access/repositories", admin, async (c) => {
    const a = c.get("auth");
    const body = parsed(
      accessReposSchema.safeParse(await parseBody(c.req.raw)),
    );
    return c.json(
      await listLibraryAccessRepos(
        a.organizationId,
        a.userId,
        body.appConnectionId
          ? { appConnectionId: body.appConnectionId }
          : body.grant
            ? { grant: body.grant }
            : {},
      ),
    );
  });

  // DELETE /org/skill-library — disconnect; every library skill leaves.
  app.delete("/", admin, async (c) => {
    const a = c.get("auth");
    const removed = await disconnectSkillSource(a.organizationId);
    await recordAuditEvent({
      organizationId: a.organizationId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.SKILL_LIBRARY,
      source: AUDIT_SOURCE.API,
      metadata: { repo: removed.repo, branch: removed.branch },
    });
    return c.body(null, 204);
  });

  // GET /org/skill-library/repo-skills — the live repo listing.
  app.get("/repo-skills", member, async (c) => {
    const a = c.get("auth");
    return c.json(await discoverLibrarySkills(a.organizationId));
  });

  // POST /org/skill-library/skills/:name/syncs — "Re-sync": check the repo
  // now and bring this skill to the branch head. Members may (it only reads
  // the repo the org already connected); the stored skill is shared, so it
  // updates every agent that holds it, and is audited.
  app.post("/skills/:name/syncs", member, async (c) => {
    const a = c.get("auth");
    const name = skillName(c.req.param("name"));
    const skill = await resyncLibrarySkill(a.organizationId, name);
    await recordAuditEvent({
      organizationId: a.organizationId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.SKILL_LIBRARY,
      source: AUDIT_SOURCE.API,
      metadata: {
        name,
        operation: "resync",
        commitSha: skill.commitSha,
        status: skill.status,
      },
    });
    return c.json(skill);
  });

  return app;
};

export const agentLibrarySkillRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // GET /agents/:agentId/library-skills — what reaches this agent.
  app.get("/:agentId/library-skills", async (c) => {
    const a = c.get("auth");
    const agentId = c.req.param("agentId");
    await requireHostedAgentInWorkspace(requireWorkspaceId(a), agentId);
    return c.json({
      skills: await listLibrarySkillsForAgent(a.organizationId, agentId),
    });
  });

  // GET /agents/:agentId/library-skills/available — the live repo listing,
  // marked with what this agent already has. 404 when no repo is connected.
  app.get("/:agentId/library-skills/available", async (c) => {
    const a = c.get("auth");
    const agentId = c.req.param("agentId");
    await requireHostedAgentInWorkspace(requireWorkspaceId(a), agentId);
    return c.json(await discoverLibrarySkills(a.organizationId, agentId));
  });

  // PUT /agents/:agentId/library-skills/:name — attach (idempotent).
  app.put("/:agentId/library-skills/:name", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const name = skillName(c.req.param("name"));
    const skill = await attachLibrarySkill({
      organizationId: a.organizationId,
      workspaceId,
      agentId,
      name,
      userId: a.userId,
    });
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.SKILL_LIBRARY,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, name, commitSha: skill.commitSha },
    });
    return c.json(skill);
  });

  // PATCH /agents/:agentId/library-skills/:name — { enabled }: the agent's
  // on/off switch, like a regular skill's.
  app.patch("/:agentId/library-skills/:name", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const name = skillName(c.req.param("name"));
    const body = parsed(enabledSchema.safeParse(await parseBody(c.req.raw)));
    const skill = await setAgentLibrarySkillEnabled({
      organizationId: a.organizationId,
      workspaceId,
      agentId,
      name,
      enabled: body.enabled,
    });
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.SKILL_LIBRARY,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, name, enabled: String(body.enabled) },
    });
    return c.json(skill);
  });

  // DELETE /agents/:agentId/library-skills/:name — detach.
  app.delete("/:agentId/library-skills/:name", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const name = skillName(c.req.param("name"));
    await detachLibrarySkill({
      organizationId: a.organizationId,
      workspaceId,
      agentId,
      name,
    });
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.SKILL_LIBRARY,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, name },
    });
    return c.body(null, 204);
  });

  return app;
};
