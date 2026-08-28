import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware, requireWorkspaceId } from "../middleware/auth";
import { ServiceError } from "../services/errors";
import {
  createMemory,
  deleteMemory,
  getMemory,
  getRevision,
  listMemories,
  listRevisions,
  redactRevision,
  restoreRevision,
  searchMemoriesForWorkspace,
  updateMemory,
  type MemoryAuthor,
} from "../services/agent-memory-service";
import {
  createMemorySchema,
  memoryListQuerySchema,
  updateMemorySchema,
} from "../validations/memories";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../services/audit-service";
import type { AuthContext } from "../providers/types";

/**
 * The agent's memory surface: /v1/agents/:agentId/memories[...] — composed
 * onto the /agents base path like channels and crons (mounted before the 410
 * shims; every path here is two-plus segments, so the agents router's
 * `/:agentId` single-segment routes never shadow it).
 *
 * `recordAuditEvent`, never `withAudit`: the gateway reads no memory table,
 * so a cache flush would be pure noise (the cron-surface rule).
 */

const parseBody = async (raw: Request) =>
  await raw
    .clone()
    .json()
    .catch(() => null);

/** The dashboard door's provenance: a human editing directly. */
const userAuthor = (a: AuthContext): MemoryAuthor => ({
  authorKind: "user",
  authorUserId: a.userId,
  authorEmail: a.userEmail,
  conversationId: null,
  turnId: null,
});

export const agentMemoryRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // GET /agents/:agentId/memories[?q=] — the section's payload: the index
  // (body-free), or ranked search hits when `q` is present.
  app.get("/:agentId/memories", async (c) => {
    const workspaceId = requireWorkspaceId(c.get("auth"));
    const agentId = c.req.param("agentId");
    const query = memoryListQuerySchema.safeParse({
      q: c.req.query("q"),
    });
    if (!query.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        query.error.issues[0]?.message ?? "Invalid query",
      );
    }
    if (query.data.q !== undefined) {
      return c.json({
        hits: await searchMemoriesForWorkspace(
          workspaceId,
          agentId,
          query.data.q,
        ),
      });
    }
    return c.json({ memories: await listMemories(workspaceId, agentId) });
  });

  // POST /agents/:agentId/memories
  app.post("/:agentId/memories", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const body = createMemorySchema.safeParse(await parseBody(c.req.raw));
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        body.error.issues[0]?.message ?? "Invalid body",
      );
    }
    const memory = await createMemory(
      workspaceId,
      agentId,
      body.data,
      userAuthor(a),
    );
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.MEMORY,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, memoryId: memory.id, key: memory.key },
    });
    return c.json(memory, 201);
  });

  // GET /agents/:agentId/memories/:memoryId — the full view, content included.
  app.get("/:agentId/memories/:memoryId", async (c) => {
    const workspaceId = requireWorkspaceId(c.get("auth"));
    return c.json(
      await getMemory(
        workspaceId,
        c.req.param("agentId"),
        c.req.param("memoryId"),
      ),
    );
  });

  // PATCH /agents/:agentId/memories/:memoryId — title/description/content;
  // `key` is immutable (the agent's own upsert handle and step 9's file name).
  app.patch("/:agentId/memories/:memoryId", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const memoryId = c.req.param("memoryId");
    const body = updateMemorySchema.safeParse(await parseBody(c.req.raw));
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        body.error.issues[0]?.message ?? "Invalid body",
      );
    }
    const memory = await updateMemory(
      workspaceId,
      agentId,
      memoryId,
      body.data,
      userAuthor(a),
    );
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.MEMORY,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, memoryId, fields: Object.keys(body.data) },
    });
    return c.json(memory);
  });

  // DELETE /agents/:agentId/memories/:memoryId — hard delete; the revisions
  // were the safety net and they go with it by intent (the audit row remains).
  app.delete("/:agentId/memories/:memoryId", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const memoryId = c.req.param("memoryId");
    await deleteMemory(workspaceId, agentId, memoryId);
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.MEMORY,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, memoryId },
    });
    return c.body(null, 204);
  });

  // GET /agents/:agentId/memories/:memoryId/revisions — newest first,
  // bounded by retention (no pagination needed). Content is a PREVIEW
  // (`contentTruncated` flags a clip) — at the 100k file cap a full list
  // would be a multi-megabyte response; the sheet fetches one full revision
  // on selection.
  app.get("/:agentId/memories/:memoryId/revisions", async (c) => {
    const workspaceId = requireWorkspaceId(c.get("auth"));
    return c.json({
      revisions: await listRevisions(
        workspaceId,
        c.req.param("agentId"),
        c.req.param("memoryId"),
      ),
    });
  });

  // GET .../revisions/:revisionId — one revision, full content.
  app.get("/:agentId/memories/:memoryId/revisions/:revisionId", async (c) => {
    const workspaceId = requireWorkspaceId(c.get("auth"));
    return c.json(
      await getRevision(
        workspaceId,
        c.req.param("agentId"),
        c.req.param("memoryId"),
        c.req.param("revisionId"),
      ),
    );
  });

  // POST .../revisions/:revisionId/restore — appends a new revision copying
  // the old snapshot; history shows the restore happened.
  app.post(
    "/:agentId/memories/:memoryId/revisions/:revisionId/restore",
    async (c) => {
      const a = c.get("auth");
      const workspaceId = requireWorkspaceId(a);
      const agentId = c.req.param("agentId");
      const memoryId = c.req.param("memoryId");
      const revisionId = c.req.param("revisionId");
      const memory = await restoreRevision(
        workspaceId,
        agentId,
        memoryId,
        revisionId,
        userAuthor(a),
      );
      await recordAuditEvent({
        workspaceId,
        userId: a.userId,
        userEmail: a.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.MEMORY,
        source: AUDIT_SOURCE.API,
        metadata: { agentId, memoryId, revisionId, restored: true },
      });
      return c.json(memory);
    },
  );

  // POST .../revisions/:revisionId/redact — scrub an old snapshot in place.
  app.post(
    "/:agentId/memories/:memoryId/revisions/:revisionId/redact",
    async (c) => {
      const a = c.get("auth");
      const workspaceId = requireWorkspaceId(a);
      const agentId = c.req.param("agentId");
      const memoryId = c.req.param("memoryId");
      const revisionId = c.req.param("revisionId");
      const revision = await redactRevision(
        workspaceId,
        agentId,
        memoryId,
        revisionId,
        a.userId,
      );
      await recordAuditEvent({
        workspaceId,
        userId: a.userId,
        userEmail: a.userEmail,
        action: AUDIT_ACTIONS.REDACT,
        service: AUDIT_SERVICES.MEMORY,
        source: AUDIT_SOURCE.API,
        metadata: { agentId, memoryId, revisionId },
      });
      return c.json(revision);
    },
  );

  return app;
};
