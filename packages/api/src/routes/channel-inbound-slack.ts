import { Hono } from "hono";
import { db } from "@onecli/db";
import { escapeSlackText } from "@onecli/agent-protocol";
import type { ApiEnv } from "../types";
import { getCrypto } from "../providers";
import { configuredAppUrl } from "../lib/app-origin";
import { ServiceError } from "../services/errors";
import { verifySlackSignature } from "../services/channels/providers/slack/signature";
import { dispatchSlackEvent } from "../services/channels/providers/slack/dispatch";
import { postMessage } from "../services/channels/providers/slack/slack-api";
import { parseSlackPresenceCredentials } from "../services/channels/providers/slack/types";
import { completePresenceFromOAuth } from "../services/channels/agent-channel-service";
import { decideApprovalFromChannel } from "../services/channels/channel-approval-service";
import { agentImageUrlOrNull } from "../services/agent-image-service";
import { publicApiUrl } from "../services/channels/posture";
import { logger } from "../lib/logger";

const log = logger.child({ component: "slack-inbound" });

/**
 * Slack's HTTP arm — the repo's first FREE inbound webhook surface (step 6):
 * events, interactivity, and the OAuth install callback, mounted at
 * /v1/channels/slack/*.
 *
 * TRUST MODEL. Nothing here carries our auth; trust is established per
 * request:
 * - events + interactivity: the Slack request signature, verified over the
 *   RAW body with the presence's own signing secret (looked up by the
 *   payload's `api_app_id` — safe to read pre-verification, because the
 *   signature is checked against THAT app's secret: naming someone else's
 *   app still means forging their signature);
 * - `url_verification` alone answers unverified — it is a pure challenge
 *   echo with no side effects, and at manifest-create time Slack pings the
 *   URL before we could know any secret;
 * - the OAuth callback: the HMAC-signed state (and the code exchange itself,
 *   which only client credentials we hold can complete).
 */

/** Bound the raw body before any work — Slack events are small. */
const MAX_INBOUND_BODY_BYTES = 1_000_000;

/** Slack's replay window. Checked BEFORE the DB read + KMS decrypt so a flood
 * of stale/garbage requests can't burn a decrypt per request. */
const TIMESTAMP_WINDOW_SECONDS = 60 * 5;

interface VerifiedPresence {
  id: string;
  identityRef: string | null;
  botToken: string | null;
  /** The agent's public avatar URL for `icon_url`, or null. Rides the
   * signing-secret cache, so an avatar change can lag here by up to its TTL
   * (≤60s) — acceptable for a refusal reply's icon. */
  iconUrl: string | null;
}

/**
 * A malformed or out-of-window `x-slack-request-timestamp` is rejected before
 * we touch the database or KMS — the cheap gate in front of the expensive
 * one, so an unauthenticated flood degrades to a header parse, not a decrypt.
 * (`verifySlackSignature` checks the window again over the signed value; this
 * is the pre-filter, not the authority.)
 */
const timestampInWindow = (headers: Headers): boolean => {
  const ts = Number(headers.get("x-slack-request-timestamp"));
  if (!Number.isFinite(ts)) return false;
  return (
    Math.abs(Math.floor(Date.now() / 1000) - ts) <= TIMESTAMP_WINDOW_SECONDS
  );
};

/**
 * Cache the per-app signing secret briefly, keyed by Slack app id. The DB read
 * is cheap; the KMS decrypt behind `getCrypto()` is not, and an unauthenticated
 * webhook must not turn one request into one KMS call. The secret only changes
 * on re-attach, so a short TTL is safe; a wrong/rotated secret simply fails
 * verification and is re-fetched next window.
 */
const SIGNING_SECRET_TTL_MS = 60_000;
const signingSecretCache = new Map<
  string,
  {
    signingSecret: string;
    botToken: string | null;
    presenceId: string;
    identityRef: string | null;
    iconUrl: string | null;
    at: number;
  }
>();

/**
 * Look the presence up by Slack app id and verify the signature over the raw
 * body. Every refusal is the same hint-free 401.
 */
const verifyInbound = async (
  rawBody: string,
  headers: Headers,
  apiAppId: string | undefined,
): Promise<VerifiedPresence | null> => {
  if (!apiAppId) return null;
  // Cheap pre-filter before any DB/KMS work (unauthenticated DoS surface).
  if (!timestampInWindow(headers)) return null;

  const cached = signingSecretCache.get(apiAppId);
  let entry: {
    signingSecret: string;
    botToken: string | null;
    presenceId: string;
    identityRef: string | null;
    iconUrl: string | null;
  } | null =
    cached && Date.now() - cached.at < SIGNING_SECRET_TTL_MS ? cached : null;

  if (!entry) {
    // findUnique now: `(provider, externalId)` is unique, so a squatted app id
    // is a CONFLICT at attach, never an ambiguous inbound resolution.
    const presence = await db.agentChannel.findUnique({
      where: {
        provider_externalId: { provider: "slack", externalId: apiAppId },
      },
      select: {
        id: true,
        identityRef: true,
        credentials: true,
        agent: { select: { id: true, imageKey: true } },
      },
    });
    if (!presence?.credentials) return null;
    try {
      const creds = parseSlackPresenceCredentials(
        await getCrypto().decrypt(presence.credentials),
      );
      if (!creds.signingSecret) return null;
      entry = {
        signingSecret: creds.signingSecret,
        botToken: creds.botToken ?? null,
        presenceId: presence.id,
        identityRef: presence.identityRef,
        // Same gate as the adapter config feed: Slack can never fetch a
        // localhost/plain-http icon_url, so a non-public origin sends none.
        iconUrl:
          publicApiUrl() !== null
            ? agentImageUrlOrNull(presence.agent.id, presence.agent.imageKey)
            : null,
      };
      signingSecretCache.set(apiAppId, { ...entry, at: Date.now() });
    } catch {
      return null;
    }
  }

  const ok = verifySlackSignature({
    signingSecret: entry.signingSecret,
    timestamp: headers.get("x-slack-request-timestamp") ?? undefined,
    signature: headers.get("x-slack-signature") ?? undefined,
    rawBody,
  });
  if (!ok) return null;

  return {
    id: entry.presenceId,
    identityRef: entry.identityRef,
    botToken: entry.botToken,
    iconUrl: entry.iconUrl,
  };
};

/**
 * Read the raw body, refusing an oversized one by the Content-Length header
 * FIRST so a hostile caller can't force us to buffer megabytes before the
 * check. Returns null when the body is too large or absent.
 */
const readCappedBody = async (raw: Request): Promise<string | null> => {
  const declared = Number(raw.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_INBOUND_BODY_BYTES) {
    return null;
  }
  const body = await raw.clone().text();
  // Byte length, not UTF-16 code units — a multibyte body undercounts by up to 4x.
  if (Buffer.byteLength(body, "utf8") > MAX_INBOUND_BODY_BYTES) return null;
  return body;
};

/** Fire a Slack reply without blocking the webhook ack — Slack's 3s window is
 * tight, and a slow post must not delay the 200 (nor 500 it: a 500 makes Slack
 * retry a request we already processed). Errors are swallowed and logged. */
const fireReply = (fn: () => Promise<unknown>): void => {
  void fn().catch((err: unknown) =>
    log.warn({ err }, "slack reply post failed"),
  );
};

/** Slack's documented `response_url` host. Anything else is an SSRF attempt —
 * the interactivity payload is signed with a secret the attacher knows. */
const isSlackResponseUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" && parsed.hostname === "hooks.slack.com"
    );
  } catch {
    return false;
  }
};

export const channelInboundSlackRoutes = () => {
  const app = new Hono<ApiEnv>();

  // POST /channels/slack/events — the Events API arm.
  app.post("/slack/events", async (c) => {
    const rawBody = await readCappedBody(c.req.raw);
    if (rawBody === null) return c.json({ error: "payload too large" }, 413);

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const envelope = body as {
      type?: string;
      challenge?: unknown;
      api_app_id?: string;
      event_id?: string;
      event?: unknown;
    };

    // The challenge echo — deliberately unverified (Slack pings before we could
    // know the secret; the branch is side-effect-free). Echo ONLY a short
    // string: a typed-but-unvalidated `challenge` could otherwise reflect an
    // arbitrary JSON value or a megabyte string back on our origin.
    if (
      envelope.type === "url_verification" &&
      typeof envelope.challenge === "string" &&
      envelope.challenge.length <= 256
    ) {
      return c.json({ challenge: envelope.challenge });
    }

    const presence = await verifyInbound(
      rawBody,
      c.req.raw.headers,
      envelope.api_app_id,
    );
    if (!presence) return c.json({ error: "Unauthorized" }, 401);

    if (envelope.type !== "event_callback" || !envelope.event_id) {
      return c.json({ ok: true });
    }

    const result = await dispatchSlackEvent({
      presenceId: presence.id,
      identityRef: presence.identityRef,
      event: envelope.event,
      eventId: envelope.event_id,
    });

    // Request-scoped replies for outcomes that OWE one right now, fired WITHOUT
    // blocking the ack (Slack's 3s window). Turn outcomes post NOTHING here —
    // the adapter's completion pass posts every finished turn's answer once,
    // door failures included (their `turn.error` is the answer; an immediate
    // reply here would double-deliver it).
    if (presence.botToken) {
      const botToken = presence.botToken;
      if (result.kind === "message") {
        const reply = {
          channel: result.call.replyChannel,
          threadTs: result.call.replyThreadTs ?? undefined,
        };
        if (result.outcome.kind === "refused") {
          // Covers the follow-up cap too — a refusal must stay VISIBLE, or
          // the silent-drop bug this feature killed is reborn at message #11.
          const message = result.outcome.message;
          const iconUrl = presence.iconUrl;
          fireReply(() =>
            postMessage(botToken, {
              ...reply,
              text: escapeSlackText(message),
              ...(iconUrl && { iconUrl }),
            }),
          );
        }
        // A mid-run message is no longer "busy": it lands as a follow-up
        // (steers into the live turn or runs next) and its ack is the
        // receipt reaction moving to it — no text is owed here.
      } else if (result.kind === "invite" && result.outcome.kind === "refuse") {
        // Refuse-and-stay-muted: no leave call (it would need channel-manage
        // scopes; see the door's comment). The refusal itself is the signal.
        const channel = result.call.channel;
        const message = result.outcome.message;
        const iconUrl = presence.iconUrl;
        fireReply(() =>
          postMessage(botToken, {
            channel,
            text: escapeSlackText(message),
            ...(iconUrl && { iconUrl }),
          }),
        );
      }
    }

    return c.json({ ok: true });
  });

  // POST /channels/slack/interactivity — block actions (approve/deny).
  app.post("/slack/interactivity", async (c) => {
    const rawBody = await readCappedBody(c.req.raw);
    if (rawBody === null) return c.json({ error: "payload too large" }, 413);

    // Interactivity arrives form-encoded: payload=<json>.
    const params = new URLSearchParams(rawBody);
    const payloadRaw = params.get("payload");
    if (!payloadRaw) return c.json({ error: "invalid payload" }, 400);
    let payload: {
      type?: string;
      api_app_id?: string;
      user?: { id?: string };
      actions?: { action_id?: string; value?: string }[];
      response_url?: string;
    };
    try {
      payload = JSON.parse(payloadRaw) as typeof payload;
    } catch {
      return c.json({ error: "invalid payload" }, 400);
    }

    const presence = await verifyInbound(
      rawBody,
      c.req.raw.headers,
      payload.api_app_id,
    );
    if (!presence) return c.json({ error: "Unauthorized" }, 401);

    const action = payload.actions?.[0];
    const clicker = payload.user?.id;
    if (
      payload.type !== "block_actions" ||
      !action?.value ||
      !clicker ||
      (action.action_id !== "channel_approve" &&
        action.action_id !== "channel_deny")
    ) {
      return c.json({ ok: true });
    }

    const decision = await decideApprovalFromChannel({
      presenceId: presence.id,
      approvalId: action.value,
      decision: action.action_id === "channel_approve" ? "approve" : "deny",
      clickerExternalUserId: clicker,
    });

    // Update the card through response_url (block_actions ignores the HTTP
    // response body; the ack is the 200 itself, inside Slack's 3s window).
    // `response_url` comes from the (signature-verified) payload, but the
    // signing secret is known to whoever attached the presence — so a workspace
    // member could sign a payload naming an INTERNAL url and turn this into a
    // blind SSRF POST from inside the VPC. Allowlist Slack's documented host.
    if (payload.response_url && isSlackResponseUrl(payload.response_url)) {
      const responseUrl = payload.response_url;
      const text =
        decision.kind === "decided"
          ? `${action.action_id === "channel_approve" ? "✅ Approved" : "⛔ Denied"} by ${escapeSlackText(decision.decidedByName)}`
          : decision.kind === "already_settled"
            ? "This request was already decided."
            : escapeSlackText(decision.message);
      const replaceOriginal = decision.kind !== "refused";
      fireReply(() =>
        fetch(responseUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            replaceOriginal
              ? { replace_original: true, text }
              : { replace_original: false, response_type: "ephemeral", text },
          ),
          signal: AbortSignal.timeout(10_000),
        }),
      );
    }

    return c.json({ ok: true });
  });

  // GET /channels/slack/oauth/callback — the events arm's install landing.
  app.get("/slack/oauth/callback", async (c) => {
    const state = c.req.query("state");
    const code = c.req.query("code");
    const denied = c.req.query("error");

    const escapeHtml = (raw: string) =>
      raw
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    const fallback = (message: string) =>
      c.html(
        `<!doctype html><meta charset="utf-8"><title>Slack install</title><body style="font-family:system-ui;padding:2rem;max-width:32rem;margin:auto"><p>${escapeHtml(message)}</p><p>Close this window and try again from the dashboard.</p></body>`,
        400,
      );

    if (denied) return fallback("The install was cancelled in Slack.");
    if (!state || !code) return fallback("This install link is not valid.");

    const apiUrl = publicApiUrl();
    if (!apiUrl) return fallback("This deployment cannot complete installs.");

    try {
      const completed = await completePresenceFromOAuth({
        state,
        code,
        // The SAME origin the manifest baked — one function, so the exchange
        // and the registered redirect URL can never disagree.
        redirectUri: `${apiUrl}/v1/channels/slack/oauth/callback`,
      });
      const appUrl = configuredAppUrl();
      if (!appUrl) {
        // Installed fine; we just have nowhere configured to send the
        // browser. Say so instead of redirecting into the void.
        return c.html(
          `<!doctype html><meta charset="utf-8"><title>Slack install</title><body style="font-family:system-ui;padding:2rem;max-width:32rem;margin:auto"><p>Installed! Close this window and return to the dashboard.</p></body>`,
        );
      }
      return c.redirect(
        `${appUrl}/w/${encodeURIComponent(completed.workspaceId)}/agents/${encodeURIComponent(completed.agentId)}/channels?connected=slack`,
      );
    } catch (err) {
      if (err instanceof ServiceError) return fallback(err.message);
      log.error({ err }, "slack oauth callback failed");
      return fallback("The install could not be completed.");
    }
  });

  return app;
};
