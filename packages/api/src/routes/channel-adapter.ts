import { Hono } from "hono";
import { db } from "@onecli/db";
import {
  adapterRegisterRequestSchema,
  type AdapterConfigResponse,
  type AdapterIngestResponse,
  type AdapterWorkResponse,
} from "@onecli/agent-protocol";
import {
  channelAdapterAuth,
  type ChannelAdapterEnv,
} from "../middleware/channel-adapter-auth";
import { ServiceError } from "../services/errors";
import {
  advanceMirrorCursor,
  claimApprovalPrompt,
  getAdapterConfig,
  getAdapterWork,
  heartbeatAdapter,
  listUnsettledPrompts,
  recordApprovalPromptMessage,
  registerAdapter,
  reportApprovalAuth,
  requireLinkedConversation,
  settleApprovalPrompt,
} from "../services/channels/channel-adapter-service";
import { decideApprovalFromChannel } from "../services/channels/channel-approval-service";
import {
  decideReachFromChannel,
  sweepUnpostedReachCards,
} from "../services/channels/agent-reach-service";
import { rotateStaleIntegrations } from "../services/channels/channel-integration-service";
import { clearTurnReceipts } from "../services/channels/turn-receipt-service";
import {
  channelProvider,
  isChannelProviderId,
} from "../services/channels/registry";
import { readTranscriptEvents } from "../services/turn-service";
import {
  adapterApprovalHealthSchema,
  adapterCursorSchema,
  adapterDecisionSchema,
  adapterIngestSchema,
  adapterPromptClaimSchema,
  adapterPromptMessageSchema,
  adapterPromptSettleSchema,
  adapterReachDecisionSchema,
} from "../validations/channels";
import { transcriptQuerySchema } from "../validations/conversation";
import { logger } from "../lib/logger";

const log = logger.child({ component: "channel-adapter-routes" });

/**
 * The channel adapter's API (step 6): outbound-only daemon calling in —
 * register, config feed, batched work poll, the ingest door, approvals, and
 * a fenced read of linked conversations. Authenticated ONLY by the `cha_`
 * family (`channelAdapterAuth`); this surface never accepts a user key or an
 * `rnr_` token, and a `cha_` token never reaches the general `/v1` surface.
 */

const parseBody = async (raw: Request) =>
  await raw
    .clone()
    .json()
    .catch(() => null);

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

const iso = (value: Date | null): string | null =>
  value ? value.toISOString() : null;

export const channelAdapterRoutes = () => {
  const app = new Hono<ChannelAdapterEnv>();

  /**
   * POST /channel-adapter/register — the only route not behind the
   * middleware: the token IS the subject, checked against an existing row or
   * the instance anchor (the runner's registration law).
   */
  app.post("/register", async (c) => {
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token.startsWith("cha_"))
      return c.json({ error: "Unauthorized" }, 401);

    const body = adapterRegisterRequestSchema.safeParse(
      await parseBody(c.req.raw),
    );
    if (!body.success) {
      return c.json(
        { error: body.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const result = await registerAdapter({
      token,
      name: body.data.name,
      perInstance: body.data.perInstance,
    });
    if (!result.ok) return c.json({ error: "Unauthorized" }, 401);

    // The minted per-instance bearer travels once, here, over the channel the
    // anchor just authenticated — and never into the log line.
    log.info({ adapterId: result.adapterId }, "channel adapter registered");
    return c.json({
      adapterId: result.adapterId,
      ...(result.mintedToken && { token: result.mintedToken }),
    });
  });

  app.use("*", channelAdapterAuth);

  app.post("/heartbeat", async (c) => {
    await heartbeatAdapter(c.get("channelAdapter").adapterId);
    return c.json({ ok: true });
  });

  // GET /channel-adapter/config — everything THIS instance holds open (its
  // ownership slice, claimed at the top of the call). `If-None-Match`
  // against the content etag turns the steady state into a 304.
  app.get("/config", async (c) => {
    const config = await getAdapterConfig(
      c.get("channelAdapter"),
      c.req.header("if-none-match"),
    );
    if (config.notModified) {
      c.header("ETag", config.etag);
      return c.body(null, 304);
    }
    const response: AdapterConfigResponse = {
      presences: config.presences.map((p) => ({
        ...p,
        links: p.links.map((l) => ({
          id: l.id,
          conversationId: l.conversationId,
          externalThreadId: l.externalThreadId,
          kind: l.kind === "direct" ? "direct" : "group",
          externalUserId: l.externalUserId,
          mirrorCursor: iso(l.mirrorCursor),
        })),
      })),
      etag: config.etag,
    };
    c.header("ETag", config.etag);
    return c.json(response);
  });

  // GET /channel-adapter/work — the batched pending-work poll (~2s): finished
  // turns past each mirror cursor, awaiting their one completion post —
  // scoped to the caller's ownership slice.
  app.get("/work", async (c) => {
    const work = await getAdapterWork(c.get("channelAdapter").adapterId);
    // The reach-card retry arm rides this ~2s cadence, detached and bounded
    // (take 5 inside): a card post that failed (Slack down, credential
    // mid-rotation) self-heals without a dedicated scheduler, and a failure
    // here must never delay the work answer.
    void sweepUnpostedReachCards().catch((err: unknown) =>
      log.warn({ err }, "reach card sweep failed"),
    );
    const serialize = (items: typeof work.finished) =>
      items.map((item) => ({
        ...item,
        kind: item.kind === "direct" ? ("direct" as const) : ("group" as const),
        turn: {
          ...item.turn,
          createdAt: item.turn.createdAt.toISOString(),
          finishedAt: iso(item.turn.finishedAt),
        },
        linkMirrorCursor: iso(item.linkMirrorCursor),
      }));
    const response: AdapterWorkResponse = {
      finished: serialize(work.finished),
    };
    return c.json(response);
  });

  // POST /channel-adapter/ingest — a raw provider event. Interpretation, the
  // echo guard, idempotency, and the whole fence run control-plane-side; the
  // response tells the adapter what (if anything) to post back.
  app.post("/ingest", async (c) => {
    const body = parsed(
      adapterIngestSchema.safeParse(await parseBody(c.req.raw)),
      "Invalid ingest body",
    );

    // The adapter names the presence; resolve its identity for the echo
    // guard with one narrow query (never the full decrypted config feed).
    // `provider` picks the interpreter from the registry — the route stays
    // provider-neutral (§3.16).
    const presence = await db.agentChannel.findUnique({
      where: { id: body.presenceId },
      select: { identityRef: true, provider: true },
    });
    if (!presence) throw new ServiceError("NOT_FOUND", "Unknown presence");
    if (!isChannelProviderId(presence.provider)) {
      // A DB row from a build that knew a provider this one does not —
      // refuse loudly rather than misinterpret its events as Slack's.
      throw new ServiceError("UNPROCESSABLE", "Unknown channel provider");
    }

    const result = await channelProvider(presence.provider).dispatchInbound({
      presenceId: body.presenceId,
      identityRef: presence.identityRef,
      event: body.event,
      eventId: body.eventId,
    });

    let response: AdapterIngestResponse;
    if (result.kind === "ignored") {
      response = { kind: "ignored", reason: result.reason };
    } else if (result.kind === "invite") {
      response = {
        kind: "invite",
        outcome:
          result.outcome.kind === "duplicate"
            ? "duplicate"
            : result.outcome.kind === "accept"
              ? "accept"
              : "refuse",
        // Pass the DOOR's decision through, never re-derive it: the door
        // deliberately answers stay-muted (`leave: false`) for Slack, and a
        // wire that hardcodes refuse ⇒ leave would make a future
        // leave-capable adapter exit when the door said stay.
        leave: result.outcome.kind === "refuse" ? result.outcome.leave : false,
        message:
          result.outcome.kind === "refuse" ? result.outcome.message : null,
        channel: result.call.channel,
      };
    } else {
      const reply = {
        channel: result.call.replyChannel,
        threadTs: result.call.replyThreadTs,
      };
      const outcome = result.outcome;
      if (outcome.kind === "duplicate") {
        response = { kind: "duplicate" };
      } else if (outcome.kind === "ignored") {
        response = { kind: "ignored", reason: outcome.reason };
      } else if (outcome.kind === "refused") {
        response = { kind: "refused", message: outcome.message, reply };
      } else {
        // "turn" and "followUp" share the row shape; the kind tells the
        // adapter whether any request-scoped behavior is owed (none for a
        // follow-up — its ack is the receipt move, done control-plane-side).
        response = {
          kind: outcome.kind,
          conversationId: outcome.conversationId,
          turn: {
            id: outcome.turn.id,
            status: outcome.turn.status,
            source: outcome.turn.source,
            userId: outcome.turn.userId,
            message: outcome.turn.message,
            error: outcome.turn.error,
            errorCode: outcome.turn.errorCode,
            createdAt: outcome.turn.createdAt.toISOString(),
            finishedAt: iso(outcome.turn.finishedAt),
          },
          reply,
        };
      }
    }
    return c.json(response);
  });

  // POST /channel-adapter/decision — a forwarded button click (socket arm).
  app.post("/decision", async (c) => {
    const body = parsed(
      adapterDecisionSchema.safeParse(await parseBody(c.req.raw)),
      "Invalid decision body",
    );
    return c.json(await decideApprovalFromChannel(body));
  });

  // POST /channel-adapter/reach-decision — a forwarded reach-card click
  // (socket arm). The clicker is authorized control-plane-side exactly like
  // the approval decide; the adapter only relays.
  app.post("/reach-decision", async (c) => {
    const body = parsed(
      adapterReachDecisionSchema.safeParse(await parseBody(c.req.raw)),
      "Invalid reach decision body",
    );
    return c.json(await decideReachFromChannel(body));
  });

  // ── Approval prompts: restart-safe dedupe + the update handle ─────────────

  app.post("/prompts/claim", async (c) => {
    const body = parsed(
      adapterPromptClaimSchema.safeParse(await parseBody(c.req.raw)),
      "Invalid claim body",
    );
    return c.json(
      await claimApprovalPrompt({
        approvalId: body.approvalId,
        agentChannelId: body.presenceId,
        externalThreadId: body.externalThreadId,
        expiresAt: body.expiresAt === null ? null : new Date(body.expiresAt),
      }),
    );
  });

  app.post("/prompts/message", async (c) => {
    const body = parsed(
      adapterPromptMessageSchema.safeParse(await parseBody(c.req.raw)),
      "Invalid prompt-message body",
    );
    await recordApprovalPromptMessage(body.approvalId, body.externalMessageRef);
    return c.json({ ok: true });
  });

  app.post("/prompts/settle", async (c) => {
    const body = parsed(
      adapterPromptSettleSchema.safeParse(await parseBody(c.req.raw)),
      "Invalid settle body",
    );
    const prompt = await settleApprovalPrompt(body.approvalId, body.state);
    return c.json({ prompt });
  });

  app.get("/prompts/unsettled", async (c) => {
    const prompts = await listUnsettledPrompts(
      c.get("channelAdapter").adapterId,
    );
    return c.json({
      prompts: prompts.map((p) => ({
        ...p,
        expiresAt: iso(p.expiresAt),
        createdAt: p.createdAt.toISOString(),
      })),
    });
  });

  // POST /channel-adapter/cursor — compare-and-set a link's mirror cursor.
  app.post("/cursor", async (c) => {
    const body = parsed(
      adapterCursorSchema.safeParse(await parseBody(c.req.raw)),
      "Invalid cursor body",
    );
    const advanced = await advanceMirrorCursor(
      body.linkId,
      body.expect === null ? null : new Date(body.expect),
      new Date(body.next),
    );
    // A WINNING claim means the answer is posting: take the exchange's
    // "seen" reactions off — the turn's own AND its joined follow-ups' (the
    // mark may have moved onto one of them) — detached (the receipt is
    // cosmetic; the CAS answer is not). A losing claim clears nothing — the
    // winner's clear handles it.
    if (advanced && body.turnId) void clearTurnReceipts(body.turnId);
    return c.json({ advanced });
  });

  // POST /channel-adapter/rotate-integrations — the proactive credential
  // sweep (~hourly from the adapter; staleness is decided server-side).
  app.post("/rotate-integrations", async (c) =>
    c.json(await rotateStaleIntegrations()),
  );

  // POST /channel-adapter/approval-health — the poll's 401 report.
  app.post("/approval-health", async (c) => {
    const body = parsed(
      adapterApprovalHealthSchema.safeParse(await parseBody(c.req.raw)),
      "Invalid health body",
    );
    await reportApprovalAuth(body.presenceId, body.healthy);
    return c.json({ ok: true });
  });

  // ── Fenced reads of LINKED conversations ─────────────────────────────────
  // The adapter's fence is thread-link ownership, not the user privacy fence:
  // it serves every surface bound to a presence, including other users'
  // direct threads, over its own authenticated channel.

  app.get("/conversations/:conversationId/events", async (c) => {
    const conversationId = c.req.param("conversationId");
    await requireLinkedConversation(conversationId);
    const query = parsed(
      transcriptQuerySchema.safeParse(c.req.query()),
      "Invalid transcript query",
    );
    return c.json(await readTranscriptEvents(conversationId, query));
  });

  return app;
};
