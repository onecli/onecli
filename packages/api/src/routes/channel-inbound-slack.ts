import { Hono } from "hono";
import { db } from "@onecli/db";
import { escapeSlackText } from "@onecli/agent-protocol";
import type { ApiEnv } from "../types";
import { getCrypto } from "../providers";
import { configuredAppUrl } from "../lib/app-origin";
import { ServiceError } from "../services/errors";
import { verifySlackSignature } from "../services/channels/providers/slack/signature";
import { dispatchSlackEvent } from "../services/channels/providers/slack/dispatch";
import { interpretSlackEvent } from "../services/channels/providers/slack/interpret";
import { sharedSlackApp } from "../services/channels/providers/slack/shared-app";
import {
  postBlocksMessage,
  postMessage,
} from "../services/channels/providers/slack/slack-api";
import { parseSlackPresenceCredentials } from "../services/channels/providers/slack/types";
import { completePresenceFromOAuth } from "../services/channels/agent-channel-service";
import {
  completeSharedInstallFromOAuth,
  invalidateSharedInstallationCache,
  sharedInstallationByTeam,
  startMarketplaceInstall,
  stripSharedInstallUserToken,
  verifyMarketplaceInstallState,
} from "../services/channels/providers/slack/shared-install-service";
import { onboardingReplyForSlackUser } from "../services/channels/providers/slack/onboarding-service";
import { decideApprovalFromChannel } from "../services/channels/channel-approval-service";
import { decideReachFromChannel } from "../services/channels/agent-reach-service";
import { REACH_ACTION_DECISIONS } from "../services/channels/providers/slack/reach-card";
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
 * - `url_verification` alone answers unverified — verifying it is not
 *   possible on a multi-app endpoint: the handshake payload carries NO
 *   `api_app_id`, so there is no way to pick which signing secret to check,
 *   and at manifest-create time Slack pings the URL before we could know a
 *   per-agent secret at all. The branch is a pure challenge echo with no
 *   side effects, bounded to a short string;
 * - the OAuth callback: the HMAC-signed state (and the code exchange itself,
 *   which only client credentials we hold can complete).
 */

/** Bound the raw body before any work — Slack events are small. */
const MAX_INBOUND_BODY_BYTES = 1_000_000;

/** Slack's replay window. Checked BEFORE the DB read + KMS decrypt so a flood
 * of stale/garbage requests can't burn a decrypt per request. */
const TIMESTAMP_WINDOW_SECONDS = 60 * 5;

/** Slack retries any non-2xx event delivery (3 tries: ~0s, +1 min, +5 min)
 * unless this header says not to. Our non-2xx answers are deliberate
 * refusals a retry can never fix — don't make Slack burn its retries, or
 * count our refusals toward its failure-rate cutoff. */
const NO_RETRY = { "x-slack-no-retry": "1" } as const;

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
        status: true,
        identityRef: true,
        credentials: true,
        agent: { select: { id: true, imageKey: true } },
      },
    });
    if (!presence?.credentials) return null;
    // Lifecycle fence — the same law the adapter config feed enforces: a
    // detached shell (pending_setup) keeps its credentials so a resume can
    // rebuild the consent URL, but it must not process events ("it stops
    // receiving messages" is the detach promise), and a disabled presence is
    // off. Refused rows are never cached, so a re-activation takes effect
    // immediately; a just-detached presence can ride an already-cached entry
    // for up to the 60s TTL — the same lag rotation already accepts.
    if (presence.status !== "active" && presence.status !== "needs_attention") {
      return null;
    }
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

// ── The SHARED app's inbound arm ───────────────────────────────────────

/**
 * Verify a shared-app request: the signing secret is DEPLOYMENT config (env),
 * not a presence row — no DB read, no KMS call. Same timestamp pre-filter,
 * same hint-free refusal.
 */
const verifySharedInbound = (
  rawBody: string,
  headers: Headers,
): { appId: string } | null => {
  const app = sharedSlackApp();
  if (!app) return null;
  if (!timestampInWindow(headers)) return null;
  const ok = verifySlackSignature({
    signingSecret: app.signingSecret,
    timestamp: headers.get("x-slack-request-timestamp") ?? undefined,
    signature: headers.get("x-slack-signature") ?? undefined,
    rawBody,
  });
  return ok ? { appId: app.appId } : null;
};

/** Is this envelope addressed to the shared app at all? Pre-verification
 * routing only — the signature check above is the authority. */
const isSharedAppId = (apiAppId: string | undefined): boolean => {
  const app = sharedSlackApp();
  return app !== null && apiAppId === app.appId;
};

/**
 * Shared-arm event dedupe. Slack retries failed deliveries up to 3 times
 * (immediately, +1 min, +5 min — a ~6-minute window); a duplicate would
 * re-post the onboarding button. In-memory on purpose — the shared arm has
 * no presence row to hang the DB dedupe on, a restart mid-window costs at
 * most one extra button, and the reply underneath is resend-idempotent
 * (`onboardingReplyForSlackUser` reuses a live pending invitation before
 * minting — createInvitation itself would NOT be: its upsert rotates the
 * token).
 */
const SHARED_EVENT_TTL_MS = 2 * 60 * 60 * 1000;
const sharedSeenEvents = new Map<string, number>();
const recordSharedEventOnce = (
  installationId: string,
  eventId: string,
): boolean => {
  const key = `${installationId}:${eventId}`;
  const now = Date.now();
  // Opportunistic prune — the map must stay a working set.
  if (sharedSeenEvents.size > 10_000) {
    for (const [k, at] of sharedSeenEvents) {
      if (now - at > SHARED_EVENT_TTL_MS) sharedSeenEvents.delete(k);
    }
  }
  const seen = sharedSeenEvents.get(key);
  if (seen !== undefined && now - seen < SHARED_EVENT_TTL_MS) return false;
  sharedSeenEvents.set(key, now);
  return true;
};

/** The onboarding reply post — one primary URL button when there is a link
 * to offer, plain text otherwise. Shared by the DM door and the app-home
 * welcome; callers pass a verified target and pre-built reply. */
const postOnboardingReply = (
  botToken: string,
  target: { channel: string; threadTs?: string },
  onboarding: { text: string; button: { label: string; url: string } | null },
) => {
  if (!onboarding.button) {
    return postMessage(botToken, {
      ...target,
      text: escapeSlackText(onboarding.text),
    });
  }
  return postBlocksMessage(botToken, {
    ...target,
    text: escapeSlackText(onboarding.text),
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: escapeSlackText(onboarding.text) },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: onboarding.button.label },
            url: onboarding.button.url,
            action_id: "onboarding_open",
          },
        ],
      },
    ],
  });
};

export const channelInboundSlackRoutes = () => {
  const app = new Hono<ApiEnv>();

  // POST /channels/slack/events — the Events API arm.
  app.post("/events", async (c) => {
    const rawBody = await readCappedBody(c.req.raw);
    if (rawBody === null)
      return c.json({ error: "payload too large" }, 413, NO_RETRY);

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "invalid json" }, 400, NO_RETRY);
    }
    const envelope = body as {
      type?: string;
      challenge?: unknown;
      api_app_id?: string;
      team_id?: string;
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

    // ── The SHARED app's arm: the org-wide OneCLI onboarding bot. One app
    // id for every workspace install; a DM (or mention) gets the account
    // button back — no agent routing, that is the dedicated apps' job. ──
    if (isSharedAppId(envelope.api_app_id)) {
      const verified = verifySharedInbound(rawBody, c.req.raw.headers);
      if (!verified) return c.json({ error: "Unauthorized" }, 401, NO_RETRY);

      if (envelope.type !== "event_callback" || !envelope.event_id) {
        return c.json({ ok: true });
      }

      // Lifecycle: the workspace removed the app, or revoked tokens. On a
      // full removal, delete the install row so the org card tells the truth
      // and the stale bot token stops being decryptable state we hold for
      // nothing (a re-install recreates the row).
      const eventType = (envelope.event as { type?: string } | undefined)?.type;
      if (eventType === "app_uninstalled" && envelope.team_id) {
        await db.channelInstallation.deleteMany({
          where: { provider: "slack", externalId: envelope.team_id },
        });
        invalidateSharedInstallationCache(envelope.team_id);
        log.info(
          { teamId: envelope.team_id, eventType },
          "shared slack install removed by workspace",
        );
        return c.json({ ok: true });
      }
      // `tokens_revoked` can be PARTIAL: `tokens.oauth`/`tokens.bot` list the
      // users whose tokens died. The bot token gone = the install is dead,
      // same as uninstall. Only USER tokens gone (the installing admin was
      // deactivated, or trimmed the grant) = the bot lives on — drop the dead
      // user token so the mint capability reads false instead of failing at
      // call time, and keep the install.
      if (eventType === "tokens_revoked" && envelope.team_id) {
        const revoked = (
          envelope.event as {
            tokens?: { oauth?: unknown; bot?: unknown };
          }
        ).tokens;
        const botRevoked =
          Array.isArray(revoked?.bot) && revoked.bot.length > 0;
        if (botRevoked) {
          await db.channelInstallation.deleteMany({
            where: { provider: "slack", externalId: envelope.team_id },
          });
          log.info(
            { teamId: envelope.team_id, eventType },
            "shared slack install removed by workspace",
          );
        } else {
          // TARGETED: `tokens.oauth` names whose xoxp tokens died — only the
          // stored installer's revocation may strip the mint grant (another
          // member who once authorized the app getting deactivated must not).
          const revokedUserIds = Array.isArray(revoked?.oauth)
            ? revoked.oauth.filter((id): id is string => typeof id === "string")
            : [];
          await stripSharedInstallUserToken(envelope.team_id, revokedUserIds);
          log.info(
            { teamId: envelope.team_id },
            "shared slack install kept; revoked user token stripped if it was the installer's",
          );
        }
        invalidateSharedInstallationCache(envelope.team_id);
        return c.json({ ok: true });
      }

      const installation = await sharedInstallationByTeam(envelope.team_id);
      // An event from a workspace we have no install row for (uninstalled,
      // or an admin-approved install that never completed OAuth): nothing to
      // route to, ack and drop.
      if (!installation) return c.json({ ok: true });

      // First-open welcome (a Marketplace guideline): opening the app's
      // Messages tab greets the user with the same onboarding reply a DM
      // earns. `app_home_opened` fires on EVERY open, so the dedupe key is
      // the USER, not the event. The mark is the in-memory map above, so
      // "once" really means once per api-server task per 2h window — a
      // returning user may be re-greeted after a redeploy or a long gap,
      // which is accepted (the reply is idempotent and reuses any live
      // pending invitation).
      const homeOpened = envelope.event as
        | { type?: string; user?: string; tab?: string }
        | undefined;
      if (homeOpened?.type === "app_home_opened") {
        if (
          homeOpened.tab !== "messages" ||
          typeof homeOpened.user !== "string" ||
          !installation.botToken
        ) {
          return c.json({ ok: true });
        }
        const firstOpen = recordSharedEventOnce(
          installation.id,
          `home-welcome:${homeOpened.user}`,
        );
        if (!firstOpen) return c.json({ ok: true });
        const botToken = installation.botToken;
        const externalUserId = homeOpened.user;
        fireReply(async () => {
          const onboarding = await onboardingReplyForSlackUser({
            installationId: installation.id,
            externalUserId,
          });
          if (!onboarding) return;
          // The DM channel with the app: chat.postMessage accepts the user
          // id as the channel and opens the conversation implicitly.
          return postOnboardingReply(
            botToken,
            { channel: externalUserId },
            onboarding,
          );
        });
        return c.json({ ok: true });
      }

      // Interpret with the shared bot's own id as the echo guard; only a
      // human's DM or a mention earns a reply.
      const call = interpretSlackEvent(envelope.event, {
        botUserId: installation.botUserId,
      });
      const addressed =
        call.door === "direct" || (call.door === "group" && call.isMention);
      if (!addressed) return c.json({ ok: true });

      // At-least-once dedupe (the in-memory map above): Slack retries
      // failed deliveries, and a duplicate here would spam the invite
      // button (and mint invitation resends).
      const fresh = recordSharedEventOnce(installation.id, envelope.event_id);
      if (!fresh) return c.json({ ok: true });

      if (!installation.botToken) {
        log.warn(
          { installationId: installation.id },
          "shared install has no bot token; the onboarding reply was owed and dropped",
        );
        return c.json({ ok: true });
      }

      const botToken = installation.botToken;

      // A channel MENTION never carries the onboarding payload: the reply
      // lands in the thread, and the full reply holds the speaker's email
      // and a live invitation link — in front of the whole channel, Slack
      // Connect externals included. Point the person at the private door;
      // the DM path carries the button. (No users.info, no mint here — the
      // public arm touches nothing personal.)
      if (call.door === "group") {
        const channelReply = {
          channel: call.replyChannel,
          threadTs: call.replyThreadTs,
        };
        fireReply(() =>
          postMessage(botToken, {
            ...channelReply,
            text: escapeSlackText(
              "Happy to help! Send me a direct message and I'll set up your OneCLI account.",
            ),
          }),
        );
        return c.json({ ok: true });
      }

      const externalUserId = call.externalUserId;
      // Answer where they asked: a DM typed inside a thread is replied to in
      // that thread, not at the bottom of the DM. `postOnboardingReply`
      // already takes an optional `threadTs` — the interpreter simply had
      // nothing to give it before.
      const reply = {
        channel: call.replyChannel,
        ...(call.replyThreadTs && { threadTs: call.replyThreadTs }),
      };
      // Detached from the ack (Slack's 3s window): the reply does a
      // users.info round-trip and possibly an invitation write.
      fireReply(async () => {
        const onboarding = await onboardingReplyForSlackUser({
          installationId: installation.id,
          externalUserId,
        });
        if (!onboarding) return;
        return postOnboardingReply(botToken, reply, onboarding);
      });

      return c.json({ ok: true });
    }

    const presence = await verifyInbound(
      rawBody,
      c.req.raw.headers,
      envelope.api_app_id,
    );
    if (!presence) return c.json({ error: "Unauthorized" }, 401, NO_RETRY);

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
  app.post("/interactivity", async (c) => {
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

    const action = payload.actions?.[0];
    const clicker = payload.user?.id;
    const actionable = (p: typeof payload, a: typeof action) =>
      p.type === "block_actions" &&
      !!a?.value &&
      (a.action_id === "channel_approve" || a.action_id === "channel_deny");
    // The reach card's buttons (agent-reach-service): same shape, its own
    // door. The settlement is null unless this really is a block_actions
    // click on one of the card's action ids - the type guard is part of the
    // classification, not a separate check a later edit can drop.
    const reachDecisionKind =
      payload.type === "block_actions" && action?.action_id
        ? (REACH_ACTION_DECISIONS[action.action_id] ?? null)
        : null;

    // ── The SHARED app's arm: the onboarding bot has ONE interactive
    // element, a URL button — Slack still posts a block_actions payload on
    // click, and the 200 IS the ack (no server-side action to take: the
    // browser already opened the URL). Verified so a forged payload learns
    // nothing, then acked. ──
    if (isSharedAppId(payload.api_app_id)) {
      if (!verifySharedInbound(rawBody, c.req.raw.headers)) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      return c.json({ ok: true });
    }

    const presence = await verifyInbound(
      rawBody,
      c.req.raw.headers,
      payload.api_app_id,
    );
    if (!presence) return c.json({ error: "Unauthorized" }, 401);

    // The reach card's own branch: decide + settle-via-response_url, then
    // ack. The service rewrites every OTHER owner's card through its
    // promptRefs; THIS card is rewritten through response_url below (the
    // 3s-window pattern the approval branch uses).
    if (reachDecisionKind && action?.value && clicker) {
      const reachDecision = await decideReachFromChannel({
        presenceId: presence.id,
        grantId: action.value,
        decision: reachDecisionKind,
        clickerExternalUserId: clicker,
      });
      if (payload.response_url && isSlackResponseUrl(payload.response_url)) {
        const responseUrl = payload.response_url;
        const text =
          reachDecision.kind === "decided"
            ? `${
                reachDecision.state === "approved"
                  ? "✅ Answering anyone in the channel"
                  : reachDecision.state === "blocked"
                    ? "⛔ Not answering there"
                    : "🔒 OneCLI users only"
              } · decided by ${escapeSlackText(reachDecision.decidedByName)}`
            : reachDecision.kind === "already_settled"
              ? "This request was already decided."
              : escapeSlackText(reachDecision.message);
        const replaceOriginal = reachDecision.kind !== "refused";
        fireReply(() =>
          fetch(responseUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              replaceOriginal
                ? { replace_original: true, text }
                : {
                    replace_original: false,
                    response_type: "ephemeral",
                    text,
                  },
            ),
            signal: AbortSignal.timeout(10_000),
          }),
        );
      }
      return c.json({ ok: true });
    }

    if (!actionable(payload, action) || !action?.value || !clicker) {
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

  // GET /channels/slack/direct-install — the Slack Marketplace "Install"
  // door. Slack validates this contract when the listing's Direct Install
  // URL is configured: a GET here must 302 to a fully-qualified authorize
  // URL. Because WE mint that URL, it carries a signed anonymous state (the
  // Marketplace guideline wants state on every authorize) — the org binds
  // later at /slack/installed, from a session. Hint-free 404 when the
  // deployment has no shared app.
  app.get("/direct-install", (c) => {
    const started = startMarketplaceInstall();
    if (!started) return c.json({ error: "Not found" }, 404);
    return c.redirect(started.installUrl);
  });

  // GET /channels/slack/oauth/callback — the events arm's install landing.
  app.get("/oauth/callback", async (c) => {
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
    if (!code) return fallback("This install link is not valid.");

    const apiUrl = publicApiUrl();
    if (!apiUrl) return fallback("This deployment cannot complete installs.");
    const redirectUri = `${apiUrl}/v1/channels/slack/oauth/callback`;

    // ── The MARKETPLACE arm: no state, so the install began OUTSIDE OneCLI
    // (Slack's app directory, or the app's sharable URL). Nobody is signed
    // in yet, so there is no org to bind to — hand the browser to the app
    // carrying the code, and let the finish page bind it once the person
    // signs in. Slack requires this path to work: the directory's own
    // "Add to Slack" button mints exactly this stateless callback. ──
    if (!state) {
      const appUrl = configuredAppUrl();
      if (!appUrl) {
        return fallback(
          "This deployment cannot complete installs started from Slack.",
        );
      }
      return c.redirect(
        `${appUrl}/slack/installed?code=${encodeURIComponent(code)}`,
      );
    }

    // ROUTE by the state's kind — an unverified peek only (each completer
    // re-verifies the HMAC itself before trusting anything in it).
    const stateKind = ((): string | null => {
      try {
        const decoded = JSON.parse(
          Buffer.from(state, "base64url").toString(),
        ) as { data?: { kind?: unknown } };
        return typeof decoded.data?.kind === "string"
          ? decoded.data.kind
          : null;
      } catch {
        return null;
      }
    })();

    // ── The DIRECT-INSTALL arm: our Marketplace door minted this state —
    // an anonymous nonce with no org (nobody was signed in). Verify it is
    // ours and current, then park the code exactly like the stateless arm:
    // the finish page binds the org from whoever signs in. ──
    if (stateKind === "marketplace-install") {
      if (!verifyMarketplaceInstallState(state)) {
        return fallback("This install link is not valid.");
      }
      const appUrl = configuredAppUrl();
      if (!appUrl) {
        return fallback(
          "This deployment cannot complete installs started from Slack.",
        );
      }
      return c.redirect(
        `${appUrl}/slack/installed?code=${encodeURIComponent(code)}`,
      );
    }

    // ── The SHARED app's arm: a workspace-level install, no agent yet. ──
    if (stateKind === "shared-install") {
      try {
        const completed = await completeSharedInstallFromOAuth({
          state,
          code,
          redirectUri,
        });
        const appUrl = configuredAppUrl();
        if (!appUrl) {
          return c.html(
            `<!doctype html><meta charset="utf-8"><title>Slack install</title><body style="font-family:system-ui;padding:2rem;max-width:32rem;margin:auto"><p>Installed! Close this window and return to the dashboard.</p></body>`,
          );
        }
        return c.redirect(
          `${appUrl}/org/${encodeURIComponent(completed.organizationId)}/channels?connected=slack`,
        );
      } catch (err) {
        if (err instanceof ServiceError) return fallback(err.message);
        log.error({ err }, "slack shared install callback failed");
        return fallback("The install could not be completed.");
      }
    }

    try {
      const completed = await completePresenceFromOAuth({
        state,
        code,
        // The SAME origin the manifest baked — one function, so the exchange
        // and the registered redirect URL can never disagree.
        redirectUri,
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
