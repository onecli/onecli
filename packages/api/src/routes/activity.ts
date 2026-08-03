import { Hono } from "hono";
import { z } from "zod";
import type { ApiEnv } from "../types";
import { authMiddleware, requireProjectId } from "../middleware/auth";
import {
  getRequestLogById,
  getRequestLogs,
  type ActivityQuery,
} from "../services/request-log-service";

/**
 * A bounded page size. The service already clamps to 200; declaring it here
 * turns an out-of-range `limit` into a 400 the caller can act on rather than a
 * silently different page.
 */
const MAX_LIMIT = 200;

/**
 * `since`/`until` accept anything `Date` parses (ISO-8601 in practice).
 * Rejected explicitly rather than coerced, because a silently-dropped bound
 * would answer "no events since X" with events from all time — the failure
 * mode most likely to be read as "OneCLI isn't logging".
 */
const dateParam = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO-8601 timestamp")
  .transform((v) => new Date(v));

const listQuerySchema = z.object({
  agentId: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  status: z.coerce.number().int().min(100).max(599).optional(),
  since: dateParam.optional(),
  until: dateParam.optional(),
  filter: z.enum(["all", "hide-llm", "blocked"]).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  // Keyset cursor, echoed back from a previous page's `nextCursor`.
  cursorCreatedAt: z.string().optional(),
  cursorId: z.string().optional(),
});

export const activityRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  /**
   * GET /activity
   *
   * Read-only, project-scoped feed of gateway request activity — the API behind
   * "did my agent's call actually go through OneCLI?" (#411). Same rows, same
   * ordering, and the same org-rule redaction the dashboard's Activity page
   * gets; this is a second surface over one service, never a way around it.
   */
  app.get("/", async (c) => {
    const auth = c.get("auth");
    const projectId = requireProjectId(auth);

    const parsed = listQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        {
          error: issue
            ? `Invalid query parameter "${issue.path.join(".")}": ${issue.message}`
            : "Invalid query parameters",
        },
        400,
      );
    }

    const { filter, limit, cursorCreatedAt, cursorId, since, until, ...rest } =
      parsed.data;

    // Both halves or neither: a half-cursor would silently restart at page one
    // and an automation paging through would loop forever on the first page.
    if (!!cursorCreatedAt !== !!cursorId) {
      return c.json(
        {
          error:
            "cursorCreatedAt and cursorId must be provided together — pass back the `nextCursor` object from the previous page.",
        },
        400,
      );
    }

    if (since && until && since >= until) {
      return c.json({ error: "since must be earlier than until" }, 400);
    }

    const query: ActivityQuery = { ...rest, since, until };

    const page = await getRequestLogs(
      projectId,
      {
        ...(filter ? { filter } : {}),
        ...(limit ? { limit } : {}),
        ...(cursorCreatedAt && cursorId
          ? { cursor: { createdAt: cursorCreatedAt, id: cursorId } }
          : {}),
        query,
      },
      { userId: auth.userId, organizationId: auth.organizationId },
    );

    return c.json(page);
  });

  /**
   * GET /activity/:id
   *
   * One event. 404 covers both "no such id" and "not this project's id" — the
   * service scopes the lookup, so the two are indistinguishable to the caller
   * by design.
   */
  app.get("/:id", async (c) => {
    const auth = c.get("auth");
    const projectId = requireProjectId(auth);

    const entry = await getRequestLogById(projectId, c.req.param("id"), {
      userId: auth.userId,
      organizationId: auth.organizationId,
    });

    if (!entry) return c.json({ error: "Activity event not found" }, 404);

    return c.json(entry);
  });

  return app;
};
