import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware, requireWorkspaceId } from "../middleware/auth";
import { ServiceError } from "../services/errors";
import {
  createConversation,
  getConversation,
  listConversations,
  requireConversation,
} from "../services/conversation-service";
import {
  abortTurn,
  createTurn,
  listTurns,
  readTranscript,
} from "../services/turn-service";
import { sendConversationMessage } from "../services/follow-up-service";
import {
  createPendingAttachment,
  getAttachmentForDownload,
} from "../services/attachment-service";
import { streamTranscript } from "./transcript-stream";
import {
  createConversationSchema,
  createTurnSchema,
  cursorSchema,
  transcriptQuerySchema,
} from "../validations/conversation";
import {
  attachmentMimeSchema,
  attachmentNameSchema,
} from "../validations/attachments";
import { readCappedBinaryBody } from "../lib/read-capped-binary-body";
import { MAX_ATTACHMENT_BYTES } from "@onecli/agent-protocol";

/**
 * Conversations, turns, and the transcript (step 4; per-user direct threads
 * since step 6 — every read/write passes the session's user as the viewer, so
 * the direct-thread privacy fence composes into each service query).
 *
 * No `invalidateGatewayCache` anywhere in this file: the gateway reads none of
 * these columns. No `withAudit` either — it flushes that cache unconditionally,
 * which is exactly the flush we do not want.
 */

const parseBody = async (raw: Request) =>
  await raw
    .clone()
    .json()
    .catch(() => null);

/** Validation failures throw so they render as the standard error envelope. */
const parsed = <T>(
  result: {
    success: boolean;
    data?: T;
    error?: { issues: { message?: string }[] };
  },
  fallback: string,
): T => {
  if (!result.success || result.data === undefined) {
    throw new ServiceError(
      "UNPROCESSABLE",
      result.error?.issues[0]?.message ?? fallback,
    );
  }
  return result.data;
};

export const conversationRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // POST /conversations — start a new exchange with a hosted agent.
  app.post("/", async (c) => {
    const workspaceId = requireWorkspaceId(c.get("auth"));
    const body = parsed(
      createConversationSchema.safeParse(await parseBody(c.req.raw)),
      "Invalid conversation body",
    );
    return c.json(await createConversation(workspaceId, body), 201);
  });

  // GET /conversations?agentId= — the agent's conversations, newest first.
  // Direct threads other than the viewer's own are fenced out server-side.
  app.get("/", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    const agentId = c.req.query("agentId");
    return c.json({
      conversations: await listConversations(workspaceId, auth.userId, agentId),
    });
  });

  // GET /conversations/:id/events — the transcript. The source of truth every
  // live stream reconciles against; registered before /:conversationId so the
  // literal sub-path wins.
  app.get("/:conversationId/events", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    const query = parsed(
      transcriptQuerySchema.safeParse(c.req.query()),
      "Invalid transcript query",
    );
    return c.json(
      await readTranscript(
        workspaceId,
        c.req.param("conversationId"),
        auth.userId,
        query,
      ),
    );
  });

  /**
   * GET /conversations/:id/stream — the live tail (SSE).
   *
   * Authenticated exactly like every other route: a bearer token or session,
   * no ticket and nothing in the URL. That means a browser reads it with
   * `fetch` rather than `EventSource` (which cannot set headers) — the same
   * shape every major model API uses, and the client keeps `Last-Event-ID`
   * semantics because each event carries its `seq` as the SSE id.
   *
   * The streaming machinery itself lives in `transcript-stream.ts`, shared
   * with the channel-adapter's stream route — only the authorization and the
   * history fence differ per caller.
   */
  app.get("/:conversationId/stream", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    const conversationId = c.req.param("conversationId");

    // Authorize BEFORE opening the stream, so a refusal is an ordinary status
    // code rather than an empty 200 that closes.
    await requireConversation(workspaceId, conversationId, auth.userId);

    const query = parsed(
      transcriptQuerySchema.safeParse(c.req.query()),
      "Invalid stream query",
    );
    // `Last-Event-ID` is the same cursor arriving by header instead of query
    // string, so it goes through the SAME schema. Coercing it by hand would
    // leave one of the two paths unvalidated — `Number("abc")` is NaN,
    // `Number("")` is 0 — and a cursor is not the place to keep a second set
    // of rules.
    const headerCursor = cursorSchema.safeParse(c.req.header("last-event-id"));
    const since =
      query.since ?? (headerCursor.success ? headerCursor.data : undefined);

    return streamTranscript(c, {
      conversationId,
      since,
      readHistory: (params) =>
        readTranscript(workspaceId, conversationId, auth.userId, params),
    });
  });

  // POST /conversations/:id/attachments?name= — stage one file for a message.
  // Raw binary body (the repo has no multipart anywhere; a browser File's own
  // Content-Type is the body's). Byte-capped mid-stream; the row stays
  // `pending` until a send binds it (or the 24h sweep reaps it).
  app.post("/:conversationId/attachments", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    const conversationId = c.req.param("conversationId");
    // Fence first (workspace + direct-thread viewer), before reading bytes.
    await requireConversation(workspaceId, conversationId, auth.userId);

    const name = parsed(
      attachmentNameSchema.safeParse(c.req.query("name")),
      "A file name is required (?name=)",
    );
    // Strip media-type parameters ("; charset=…") before the shape gate.
    const rawMime = (c.req.header("content-type") ?? "").split(";")[0]?.trim();
    const mimeType = attachmentMimeSchema.safeParse(rawMime).success
      ? (rawMime as string)
      : "application/octet-stream";

    const body = await readCappedBinaryBody(c.req.raw, MAX_ATTACHMENT_BYTES);
    if (!body.ok) {
      if (body.reason === "too_large") {
        return c.json(
          {
            error: `Files are capped at ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB.`,
          },
          413,
        );
      }
      throw new ServiceError(
        "UNPROCESSABLE",
        body.reason === "empty" ? "The file is empty." : "Unreadable upload.",
      );
    }

    const meta = await createPendingAttachment({
      conversationId,
      userId: auth.userId,
      source: "web",
      name,
      mimeType,
      bytes: body.bytes,
    });
    return c.json(meta, 201);
  });

  // GET /conversations/:id/attachments/:attachmentId — the bytes, for chip
  // previews and downloads. The conversation fence is IN the lookup's where;
  // `Content-Disposition: attachment` + nosniff always (a stored SVG/HTML
  // must never execute on this origin — previews fetch blobs with auth and
  // render via object URLs, so inline disposition buys nothing).
  app.get("/:conversationId/attachments/:attachmentId", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    const conversationId = c.req.param("conversationId");
    await requireConversation(workspaceId, conversationId, auth.userId);

    const { meta, bytes } = await getAttachmentForDownload(
      conversationId,
      c.req.param("attachmentId"),
    );
    // RFC 5987 encoding: the name is user-chosen and may be non-ASCII.
    const asciiName = meta.name.replace(/[^ -~]/g, "_").replace(/"/g, "'");
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": meta.mimeType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
    });
  });

  // GET /conversations/:id/turns — the turns of this conversation.
  app.get("/:conversationId/turns", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    return c.json({
      turns: await listTurns(
        workspaceId,
        c.req.param("conversationId"),
        auth.userId,
      ),
    });
  });

  // POST /conversations/:id/turns — say something. 409 while one is in flight.
  // The origin is stamped server-side: this door is the web (and API-key)
  // surface, so `source: "web"` — the channel doors stamp their provider.
  app.post("/:conversationId/turns", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    const body = parsed(
      createTurnSchema.safeParse(await parseBody(c.req.raw)),
      "Invalid turn body",
    );
    const turn = await createTurn(
      workspaceId,
      c.req.param("conversationId"),
      body.message,
      { source: "web", userId: auth.userId },
      body.attachmentIds,
    );
    return c.json(turn, 201);
  });

  // POST /conversations/:id/messages — say something WHATEVER the agent is
  // doing. Free conversation → an ordinary turn; turn in flight → a
  // follow-up that steers into it. The discriminated outcome tells the
  // caller which. (`/turns` above keeps its strict one-at-a-time contract
  // for API users who want the 409.)
  app.post("/:conversationId/messages", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    const body = parsed(
      createTurnSchema.safeParse(await parseBody(c.req.raw)),
      "Invalid message body",
    );
    const outcome = await sendConversationMessage(
      workspaceId,
      c.req.param("conversationId"),
      body.message,
      { source: "web", userId: auth.userId },
      body.attachmentIds,
    );
    return c.json(outcome, 201);
  });

  // GET /conversations/:id — registered after the literal sub-paths above.
  app.get("/:conversationId", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    return c.json(
      await getConversation(
        workspaceId,
        c.req.param("conversationId"),
        auth.userId,
      ),
    );
  });

  return app;
};

/**
 * Turns are addressed directly for the one genuine non-CRUD action, keeping
 * the path shallow (`CLAUDE.md`: stop nesting at ~2 levels).
 */
export const turnRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  app.post("/:turnId/abort", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    return c.json(
      await abortTurn(workspaceId, c.req.param("turnId"), auth.userId),
    );
  });

  return app;
};
