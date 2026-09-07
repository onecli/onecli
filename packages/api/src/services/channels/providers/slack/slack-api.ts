import { z } from "zod";
import { readCappedBinaryBody } from "../../../../lib/read-capped-binary-body";
import { ChannelProviderApiError } from "../../errors";

/**
 * The control plane's thin Slack Web API client — exactly the methods the
 * attach/rotate flows call, nothing more. A typed, zod-parsed `fetch` (the
 * `apps/runner/src/control-plane.ts` shape) instead of `@slack/web-api`:
 * four simple POSTs do not justify a dependency tree, and parsed-not-cast
 * responses are the house rule for every wire boundary.
 *
 * The adapter has its own sibling client for the runtime methods
 * (`apps/channel-adapter/src/providers/slack/client.ts`) — two thin clients
 * in two runtimes beat one shared package.
 */

/** Call-time read so tests can point at a fake server per invocation. */
const apiBase = (): string =>
  process.env.SLACK_API_BASE_URL ?? "https://slack.com/api";

const CALL_TIMEOUT_MS = 15_000;

/** Slack rate-limits with 429 + Retry-After (seconds) and expects callers to
 * honor it; transient 5xxs happen on their edge. One bounded retry pass:
 * marketplace review exercises rate-limit behavior, and hammering through a
 * 429 is exactly what fails it. Retries are for the HTTP layer only —
 * `ok:false` refusals are deterministic and never retried. */
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_CAP_MS = 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A Slack refusal (`ok: false`), carrying Slack's own error code verbatim —
 * the plan requires surfacing codes like `managed_app_limit_reached` to the
 * user unaltered, so the code is the message. Extends the neutral
 * `ChannelProviderApiError` so the generic error handler maps it without
 * importing anything Slack-shaped.
 */
export class SlackApiError extends ChannelProviderApiError {
  constructor(method: string, code: string) {
    super("slack", method, code, `Slack ${method} refused: ${code}`);
    this.name = "SlackApiError";
  }
}

const okEnvelope = z.object({ ok: z.boolean(), error: z.string().optional() });

const slackCall = async <T extends z.ZodType>(
  method: string,
  init: {
    token?: string;
    /** HTTP Basic credentials — Slack's PREFERRED way to send client_id/
     * client_secret on oauth.v2.access (keeps them out of the form body). */
    basicAuth?: { user: string; pass: string };
    /** Sent as `application/x-www-form-urlencoded` (Slack's lingua franca). */
    form?: Record<string, string>;
    /** Opt-in 5xx retry — ONLY for idempotent methods (reads, deletes,
     * wholesale replaces). A 5xx can arrive AFTER Slack committed the call
     * (their edge failing on the way back), so retrying a create/post/
     * exchange risks a duplicate app, a double-posted message, or burning a
     * single-use OAuth code. 429s always retry: rate limiting is by
     * definition pre-execution. */
    retry5xx?: boolean;
  },
  schema: T,
): Promise<z.infer<T>> => {
  let response: Response | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    response = await fetch(`${apiBase()}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        ...(init.token && { authorization: `Bearer ${init.token}` }),
        ...(init.basicAuth && {
          authorization: `Basic ${Buffer.from(
            `${init.basicAuth.user}:${init.basicAuth.pass}`,
          ).toString("base64")}`,
        }),
      },
      body: new URLSearchParams(init.form ?? {}).toString(),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const retryable =
      response.status === 429 ||
      (init.retry5xx === true && response.status >= 500);
    if (!retryable || attempt === MAX_ATTEMPTS) break;
    // Missing/empty header must fall to the backoff branch — Number(null)
    // is 0, which would re-hammer immediately (the exact behavior the
    // marketplace review fails apps for).
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterSeconds =
      retryAfterHeader === null || retryAfterHeader.trim() === ""
        ? Number.NaN
        : Number(retryAfterHeader);
    const waitMs = Number.isFinite(retryAfterSeconds)
      ? Math.min(retryAfterSeconds * 1000, RETRY_AFTER_CAP_MS)
      : 500 * attempt;
    await sleep(waitMs);
  }
  if (!response) throw new Error(`Slack ${method} produced no response`);
  if (!response.ok) {
    throw new Error(`Slack ${method} answered HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  const envelope = okEnvelope.parse(body);
  if (!envelope.ok) {
    throw new SlackApiError(method, envelope.error ?? "unknown_error");
  }
  return schema.parse(body);
};

const rotateResponse = z.object({
  token: z.string().min(1),
  refresh_token: z.string().min(1),
  team_id: z.string().min(1),
  exp: z.number().int(),
});

/**
 * Rotate an app-configuration token pair. Also the VALIDATOR for a pasted
 * token: rotation both proves the credential works and names the workspace —
 * and the pasted pair was going to be single-use anyway.
 */
export const rotateConfigToken = (refreshToken: string) =>
  slackCall(
    "tooling.tokens.rotate",
    { form: { refresh_token: refreshToken } },
    rotateResponse,
  );

const manifestCreateResponse = z.object({
  app_id: z.string().min(1),
  credentials: z.object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    signing_secret: z.string().min(1),
  }),
  oauth_authorize_url: z.string().min(1),
});

/** Create an app from a manifest, with a config ACCESS token. */
export const manifestCreate = (accessToken: string, manifest: unknown) =>
  slackCall(
    "apps.manifest.create",
    { token: accessToken, form: { manifest: JSON.stringify(manifest) } },
    manifestCreateResponse,
  );

/** Best-effort remote deletion at detach. */
export const manifestDelete = (accessToken: string, appId: string) =>
  slackCall(
    "apps.manifest.delete",
    { token: accessToken, form: { app_id: appId }, retry5xx: true },
    z.object({}),
  );

/**
 * The app's current manifest. `apps.manifest.update` replaces the whole
 * document, so a rename exports first and edits the result.
 *
 * Deliberately loose: pinning a schema would break the round-trip every time
 * Slack adds a manifest key.
 */
export const manifestExport = (accessToken: string, appId: string) =>
  slackCall(
    "apps.manifest.export",
    { token: accessToken, form: { app_id: appId }, retry5xx: true },
    z.object({ manifest: z.record(z.string(), z.unknown()) }),
  );

/** Replace an app's manifest wholesale — pair with `manifestExport`. */
export const manifestUpdate = (
  accessToken: string,
  appId: string,
  manifest: unknown,
) =>
  slackCall(
    "apps.manifest.update",
    {
      token: accessToken,
      form: { app_id: appId, manifest: JSON.stringify(manifest) },
      retry5xx: true,
    },
    z.object({}),
  );

/**
 * Uninstall an app from the workspace — the first half of removing one, which
 * teardown runs before deleting the manifest (the pair Slack's own CLI
 * `delete` performs). It does NOT keep the bot out of the workspace directory:
 * a bot user is a permanent record and no API removes it.
 *
 * Takes the app's OWN client credentials, not a config token — this is
 * installation-scoped, and revokes every token for that installation.
 */
export const appsUninstall = (input: {
  botToken: string;
  clientId: string;
  clientSecret: string;
}) =>
  slackCall(
    "apps.uninstall",
    {
      token: input.botToken,
      form: { client_id: input.clientId, client_secret: input.clientSecret },
      retry5xx: true,
    },
    z.object({}),
  );

const authTestResponse = z.object({
  team_id: z.string().min(1),
  team: z.string().optional(),
  /** For a bot token this is the bot's own user id. */
  user_id: z.string().min(1),
  /** The bot's own handle ("donna") — what a human sees it called in Slack. */
  user: z.string().optional(),
  bot_id: z.string().optional(),
});

/** Identify a bot token: which workspace, which bot user. */
export const authTest = (botToken: string) =>
  slackCall("auth.test", { token: botToken, retry5xx: true }, authTestResponse);

const postMessageResponse = z.object({
  channel: z.string().min(1),
  ts: z.string().min(1),
});

/**
 * Post a message — the EVENTS arm's request-scoped replies (refusals, busy
 * notices, invite refusals, the shared app's text-only onboarding answers).
 * Answer rendering/streaming stays the adapter's job; this exists so an
 * inbound HTTP event can be answered without waiting for any poll. Callers
 * pass PRE-ESCAPED text (`escapeSlackText`).
 */
export const postMessage = async (
  botToken: string,
  input: {
    channel: string;
    text: string;
    threadTs?: string;
    iconUrl?: string;
  },
) => {
  const form = {
    channel: input.channel,
    text: input.text,
    ...(input.threadTs && { thread_ts: input.threadTs }),
  };
  if (input.iconUrl) {
    try {
      return await slackCall(
        "chat.postMessage",
        // The agent's avatar. Needs `chat:write.customize` — a pre-existing
        // install predating the scope fails the whole post (`missing_scope`),
        // so that one error retries plain: the reply must land even when
        // the icon cannot. No per-token memo here (unlike the adapter's
        // client): this arm posts request-scoped replies only, far too
        // rarely to matter.
        {
          token: botToken,
          form: { ...form, icon_url: input.iconUrl },
        },
        postMessageResponse,
      );
    } catch (err) {
      if (!(err instanceof SlackApiError) || err.code !== "missing_scope") {
        throw err;
      }
    }
  }
  return slackCall(
    "chat.postMessage",
    { token: botToken, form },
    postMessageResponse,
  );
};

/**
 * Block Kit message post — the shared app's onboarding reply (a button).
 * TRUST rule (the adapter's postBlocks law): button URLs are built ONLY from
 * server-side config (APP_URL + our own token), never from anything a
 * payload carried; text is pre-escaped by the caller.
 */
export const postBlocksMessage = async (
  botToken: string,
  input: {
    channel: string;
    text: string;
    blocks: unknown[];
    threadTs?: string;
  },
) =>
  slackCall(
    "chat.postMessage",
    {
      token: botToken,
      form: {
        channel: input.channel,
        text: input.text,
        blocks: JSON.stringify(input.blocks),
        ...(input.threadTs && { thread_ts: input.threadTs }),
      },
    },
    postMessageResponse,
  );

/**
 * Reaction add/remove — the receipt lifecycle. Slack's idempotency refusals
 * (`already_reacted` / `no_reaction`) are success-shaped: the world is
 * already in the state we wanted, so they must not throw (a redelivered add
 * or a double clear would otherwise log as failures forever).
 */
const reactionCall = async (
  method: "reactions.add" | "reactions.remove",
  botToken: string,
  input: { channel: string; timestamp: string; name: string },
): Promise<void> => {
  try {
    await slackCall(
      method,
      {
        token: botToken,
        form: {
          channel: input.channel,
          timestamp: input.timestamp,
          name: input.name,
        },
        retry5xx: true,
      },
      okEnvelope,
    );
  } catch (err) {
    if (
      err instanceof SlackApiError &&
      (err.code === "already_reacted" || err.code === "no_reaction")
    ) {
      return;
    }
    throw err;
  }
};

export const reactionsAdd = (
  botToken: string,
  input: { channel: string; timestamp: string; name: string },
) => reactionCall("reactions.add", botToken, input);

/**
 * Slack's cap on a task title inside a `plan` block.
 */
export const SLACK_TASK_TITLE_MAX = 256;

/**
 * REPLACE a message's blocks — how the narration card advances.
 *
 * `chat.update` rewrites the whole message, so the card is always rendered
 * from the turn's full task list rather than patched step by step. That is
 * what makes the mechanism forgiving: there is no half-updated state to
 * reconcile, and a missed update is corrected by the next one.
 */
export const updateBlocksMessage = (
  botToken: string,
  input: { channel: string; ts: string; text: string; blocks: unknown[] },
) =>
  slackCall(
    "chat.update",
    {
      token: botToken,
      form: {
        channel: input.channel,
        ts: input.ts,
        text: input.text,
        blocks: JSON.stringify(input.blocks),
      },
    },
    okEnvelope,
  );

/**
 * REMOVE a message the app posted — how the narration card disappears when
 * the answer lands, so it is never left behind as a second reply.
 *
 * Deliberately tolerant: `message_not_found` (already gone, or deleted by
 * the user) is the expected race between the clear path and a retry, so
 * callers treat a refusal as "already removed" rather than an error.
 */
export const deleteMessage = (
  botToken: string,
  input: { channel: string; ts: string },
) =>
  slackCall(
    "chat.delete",
    { token: botToken, form: { channel: input.channel, ts: input.ts } },
    okEnvelope,
  );

/**
 * The agent-session work status (the native "Working…" loader an agent-flavor
 * app shows in a thread). `processing` turns it on; `active` clears it —
 * NEVER auto-cleared by a message post, so the receipt lifecycle owns both
 * halves. Throws on refusal (`feature_disabled` on plan-gated workspaces,
 * `missing_scope` on regular-flavor apps): the caller's reaction fallback
 * depends on hearing it.
 */
export const agentsSessionsSetStatus = (
  botToken: string,
  input: {
    channelId: string;
    threadTs: string;
    status: "processing" | "active";
  },
) =>
  slackCall(
    "agents.sessions.setStatus",
    {
      token: botToken,
      form: {
        channel_id: input.channelId,
        thread_ts: input.threadTs,
        status: input.status,
      },
      retry5xx: true,
    },
    okEnvelope,
  );

export const reactionsRemove = (
  botToken: string,
  input: { channel: string; timestamp: string; name: string },
) => reactionCall("reactions.remove", botToken, input);

const filesInfoResponse = z.object({
  file: z
    .object({
      id: z.string().min(1),
      name: z.string().nullish(),
      mimetype: z.string().nullish(),
      size: z.number().int().nullish(),
      url_private: z.string().nullish(),
    })
    .loose(),
});

/** Full metadata for one file — the Slack Connect stub's follow-up (a
 * `check_file_info` share carries no name/size/url until asked). Same
 * `files:read` scope as the download itself. */
export const filesInfo = (botToken: string, fileId: string) =>
  slackCall(
    "files.info",
    { token: botToken, form: { file: fileId }, retry5xx: true },
    filesInfoResponse,
  );

/**
 * Which URLs the bot token may EVER be sent to. `url_private` arrives inside
 * an event payload — attacker-influencable through the signing-secret /
 * adapter-token trust boundary — and the Authorization header carries the
 * workspace's bot token, so an unpinned fetch is both an SSRF primitive and
 * a token exfiltrator (the `isSlackResponseUrl` lesson, applied to files).
 * Checked on the INITIAL request and on every redirect hop. When
 * SLACK_API_BASE_URL points at a fake server (the test seam), that exact
 * origin is the allowed one.
 */
export const isSlackFilesUrl = (raw: string): boolean => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const base = process.env.SLACK_API_BASE_URL;
  if (base) {
    try {
      const baseUrl = new URL(base);
      return url.protocol === baseUrl.protocol && url.host === baseUrl.host;
    } catch {
      // Unparseable override — fall through to the production rule.
    }
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "slack.com" || host.endsWith(".slack.com");
};

/**
 * Slack's own file CDN domains — where an authenticated `files-pri` download
 * 302s to. Non-image files redirect to the safe-files CDN
 * (`slack-files.com/files-pri-safe/…`, a presigned URL that needs NO auth),
 * so a download that only trusts `*.slack.com` refuses every PDF while
 * images (served inline from `files.slack.com`) work. These hops are
 * followed WITHOUT the Authorization header: the presigned URL is its own
 * credential, and the bot token still never travels beyond
 * `isSlackFilesUrl` hosts. Kept a separate list from `isSlackFilesUrl` on
 * purpose — widening THAT pin would send the token to these hosts. Any
 * redirect outside both sets is still refused without a request: a forged
 * payload bounced through a slack.com open redirect must not turn the
 * control plane into a fetch-anything proxy. When SLACK_CDN_BASE_URL points
 * at a fake server (the test seam), that exact origin is the allowed one.
 */
export const isSlackCdnUrl = (raw: string): boolean => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const base = process.env.SLACK_CDN_BASE_URL;
  if (base) {
    try {
      const baseUrl = new URL(base);
      return url.protocol === baseUrl.protocol && url.host === baseUrl.host;
    } catch {
      // Unparseable override — fall through to the production rule.
    }
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return ["slack-files.com", "slack-imgs.com", "slack-edge.com"].some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
};

export type SlackFileDownload =
  | { ok: true; bytes: Buffer; contentType: string | null }
  | { ok: false; reason: string };

const DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_DOWNLOAD_REDIRECTS = 3;

/**
 * Download `url_private` bytes with the bot token. Redirects are followed BY
 * HAND so every hop re-passes the host pin — `fetch`'s automatic following
 * would happily replay the Authorization header to wherever Slack (or a
 * forged payload) pointed. The pin is two-tier: `isSlackFilesUrl` hosts get
 * the Bearer token; `isSlackCdnUrl` hosts (Slack's presigned file CDN, where
 * every non-image download 302s) are fetched WITHOUT it; anything else is
 * refused before any request. An HTML answer is Slack's login page — the
 * documented behavior for a missing `files:read` scope — and is refused as
 * such rather than stored as "the image".
 */
export const downloadPrivateFile = async (
  botToken: string,
  rawUrl: string,
  maxBytes: number,
): Promise<SlackFileDownload> => {
  let target = rawUrl;
  for (let hop = 0; hop <= MAX_DOWNLOAD_REDIRECTS; hop += 1) {
    // The token decision is per-hop and MUST stay in sync with the fence:
    // only `isSlackFilesUrl` hosts may ever see the Authorization header.
    const sendToken = isSlackFilesUrl(target);
    if (!sendToken && !isSlackCdnUrl(target)) {
      return { ok: false, reason: "refused a non-Slack download URL" };
    }
    let response: Response;
    try {
      response = await fetch(target, {
        headers: sendToken ? { authorization: `Bearer ${botToken}` } : {},
        redirect: "manual",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: "download failed" };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location) return { ok: false, reason: "broken redirect" };
      target = new URL(location, target).toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, reason: `download answered HTTP ${response.status}` };
    }

    const contentType = response.headers.get("content-type");
    if (contentType?.toLowerCase().includes("text/html")) {
      // Slack serves a login page instead of a 401 when the token lacks
      // files:read — storing it as the file would be worse than failing.
      await response.body?.cancel().catch(() => {});
      return {
        ok: false,
        reason:
          "Slack refused the download (reinstall the app to grant files:read)",
      };
    }

    const body = await readCappedBinaryBody(response, maxBytes);
    if (!body.ok) {
      return {
        ok: false,
        reason:
          body.reason === "too_large"
            ? "file too large"
            : "empty or unreadable download",
      };
    }
    return {
      ok: true,
      bytes: body.bytes,
      contentType: contentType?.split(";")[0]?.trim() ?? null,
    };
  }
  return { ok: false, reason: "too many redirects" };
};

const usersInfoResponse = z.object({
  user: z.object({
    id: z.string().min(1),
    /** The user's home workspace - the reach lane's same-tenant fence: a
     * Slack Connect participant carries a foreign team_id and is refused
     * even in a granted channel (v1 scope). */
    team_id: z.string().optional(),
    /** The display name a guest prefix can carry (cleaned + clamped by the
     * ingestion door before it touches a turn). */
    name: z.string().optional(),
    /** Guest/void flags - the onboarding mint fences on these: a multi- or
     * single-channel guest (contractor, client) is exactly who an admin
     * would NOT consider "my team" when consenting to workspace onboarding,
     * and a deleted or Slack-Connect-external account must never mint. */
    is_restricted: z.boolean().optional(),
    is_ultra_restricted: z.boolean().optional(),
    is_stranger: z.boolean().optional(),
    deleted: z.boolean().optional(),
    profile: z
      .object({
        email: z.string().optional(),
        display_name: z.string().optional(),
        /** Where a manifest rename lands, ASYNCHRONOUSLY - the field the
         * teardown polls to confirm the tombstone before deleting. */
        real_name: z.string().optional(),
      })
      .optional(),
  }),
});

/** A member's profile — the email the lazy account-link matches on. Needs the
 * bot token's `users:read.email`. */
export const usersInfo = (botToken: string, userId: string) =>
  slackCall(
    "users.info",
    { token: botToken, form: { user: userId }, retry5xx: true },
    usersInfoResponse,
  );

/**
 * Open (or return) the 1:1 IM with a user - where the platform-composed
 * reach card is delivered. Needs `im:write` (already in the manifest's
 * scope list from day one).
 */
export const conversationsOpen = (botToken: string, userId: string) =>
  slackCall(
    "conversations.open",
    { token: botToken, form: { users: userId }, retry5xx: true },
    z.object({ channel: z.object({ id: z.string().min(1) }) }),
  );

/**
 * A channel's display name, for the reach card's "#channel" label. Display
 * only - matching stays on the id (names rename). Best-effort at the
 * callers: a private channel the token cannot read answers an error they
 * swallow into the bare id.
 */
export const conversationsInfo = (botToken: string, channelId: string) =>
  slackCall(
    "conversations.info",
    { token: botToken, form: { channel: channelId }, retry5xx: true },
    z.object({
      channel: z.object({
        id: z.string().min(1),
        name: z.string().optional(),
      }),
    }),
  );

/**
 * Rewrite a posted message (the reach card's settle). The api-server twin
 * of the adapter's `updateBlocks` - this side posts and settles the
 * platform-composed reach cards; the adapter's own updater serves gateway
 * approval cards and never runs here.
 */
export const chatUpdate = (
  botToken: string,
  input: { channel: string; ts: string; text: string; blocks?: unknown[] },
) =>
  slackCall(
    "chat.update",
    {
      token: botToken,
      form: {
        channel: input.channel,
        ts: input.ts,
        text: input.text,
        ...(input.blocks && { blocks: JSON.stringify(input.blocks) }),
      },
    },
    z.object({ ts: z.string().min(1) }),
  );

const oauthAccessResponse = z.object({
  access_token: z.string().min(1),
  bot_user_id: z.string().min(1),
  team: z.object({ id: z.string().min(1), name: z.string().nullish() }),
  /** The installed app's id (`A…`) — the shared-install flow records it. */
  app_id: z.string().optional(),
  /** The installing USER's grant — present when `user_scope` was requested
   * (the shared install asks for the manifest+managed-install scopes). */
  authed_user: z
    .object({
      id: z.string().min(1),
      access_token: z.string().optional(),
      scope: z.string().optional(),
    })
    .optional(),
});

/** The events arm's code exchange. Client creds go as HTTP Basic (Slack's
 * documented preference over form params); `redirect_uri` matches the sole
 * configured redirect URL byte-for-byte (both come from `publicApiUrl()`). */
export const oauthAccess = (input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}) =>
  slackCall(
    "oauth.v2.access",
    {
      basicAuth: { user: input.clientId, pass: input.clientSecret },
      form: {
        code: input.code,
        redirect_uri: input.redirectUri,
      },
    },
    oauthAccessResponse,
  );
