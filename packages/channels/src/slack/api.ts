import { z } from "zod";
import { readCappedBinaryBody } from "../http";
import { ChannelProviderApiError } from "../errors";

/**
 * THE Slack Web API client — the one wire surface both runtimes share. A
 * typed, zod-parsed `fetch` instead of `@slack/web-api`: a few dozen simple
 * POSTs do not justify a dependency tree, we must own ack/refresh timing
 * precisely, and parsed-not-cast responses are the house rule for every
 * wire boundary.
 *
 * History: this began as the api's attach-time client with an adapter-side
 * runtime sibling ("two thin clients in two runtimes beat one shared
 * package" — the step-6 decision). The merge happened when a third consumer
 * appeared on the horizon (the outbound resolver): at three copies the
 * drift risk beats the coupling cost. The adapter's improvements (the
 * iconless-token memo, blocks-post icon fallback, optional update blocks)
 * came along; everything else is the api superset.
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
const INLINE_RETRY_BUDGET_MS = 10_000;

/** This shared module is client-reachable, so retries must not import Node's
 * timer module. Remove the abort listener after a completed delay, and clear
 * the timer immediately when its caller cancels. */
const waitForRetry = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * A Slack refusal (`ok: false`), carrying Slack's own error code verbatim —
 * the plan requires surfacing codes like `managed_app_limit_reached` to the
 * user unaltered, so the code is the message. Extends the neutral
 * `ChannelProviderApiError` so the generic error handler maps it without
 * importing anything Slack-shaped.
 */
export class SlackApiError extends ChannelProviderApiError {
  constructor(
    method: string,
    code: string,
    readonly retryAfterMs?: number,
  ) {
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
     * single-use OAuth code. Rate limits are pre-execution, so 429s may
     * retry within the inline budget, always honoring Retry-After. */
    retry5xx?: boolean;
    signal?: AbortSignal;
  },
  schema: T,
): Promise<z.infer<T>> => {
  let response: Response | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    init.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
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
      signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout,
    });
    const retryable =
      response.status === 429 ||
      (init.retry5xx === true && response.status >= 500);
    if (!retryable) break;
    // Missing/empty header must fall to the backoff branch — Number(null)
    // is 0, which would re-hammer immediately (the exact behavior the
    // marketplace review fails apps for).
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterSeconds =
      retryAfterHeader === null || retryAfterHeader.trim() === ""
        ? Number.NaN
        : Number(retryAfterHeader);
    const retryAfterMs =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? retryAfterSeconds * 1000
        : undefined;
    init.signal?.throwIfAborted();
    if (
      response.status === 429 &&
      (attempt === MAX_ATTEMPTS || (retryAfterMs ?? 0) > INLINE_RETRY_BUDGET_MS)
    ) {
      await response.body?.cancel();
      throw new SlackApiError(method, "ratelimited", retryAfterMs);
    }
    if (attempt === MAX_ATTEMPTS) break;
    const waitMs = retryAfterMs ?? 500 * attempt;
    await response.body?.cancel();
    if (waitMs > INLINE_RETRY_BUDGET_MS) {
      throw new SlackApiError(method, `http_${response.status}`, waitMs);
    }
    await waitForRetry(waitMs, init.signal);
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
/** Socket-mode dial-in: mint the wss URL. App-token (`xapp-`) authed —
 * the one method here whose bearer is not a bot token. */
export const connectionsOpen = (appToken: string) =>
  slackCall(
    "apps.connections.open",
    { token: appToken },
    z.object({ url: z.string().min(1) }),
  );

export const authTest = (botToken: string) =>
  slackCall("auth.test", { token: botToken, retry5xx: true }, authTestResponse);

/**
 * Bot tokens whose install predates `chat:write.customize` — the icon
 * attempt came back `missing_scope` once, so later posts skip it instead of
 * paying a doomed extra chat.postMessage per message. Time-bounded: Slack
 * KEEPS the same xoxb token across a scope-granting reinstall (the healing
 * move), so a permanent memo would strip icons forever after the user fixed
 * the install — the verdict re-probes once per window (one cheap refused
 * post). Folded in from the adapter's client at the merge.
 */
const ICONLESS_RETRY_MS = 60 * 60 * 1000;
const iconlessBotTokens = new Map<string, number>();

const iconlessMemoized = (botToken: string): boolean => {
  const at = iconlessBotTokens.get(botToken);
  return at !== undefined && Date.now() - at < ICONLESS_RETRY_MS;
};

export const resetIconlessBotTokensForTests = (): void => {
  iconlessBotTokens.clear();
};

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
  if (input.iconUrl && !iconlessMemoized(botToken)) {
    try {
      return await slackCall(
        "chat.postMessage",
        // The agent's avatar. Needs `chat:write.customize` — a pre-existing
        // install predating the scope fails the whole post (`missing_scope`),
        // so that one error retries plain: the reply must land even when
        // the icon cannot.
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
      iconlessBotTokens.set(botToken, Date.now());
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
    iconUrl?: string;
    /** No link previews under the message: an approval card links records
     *  (a Salesforce contact), and the record's own Slack app would attach
     *  a preview card of its own below ours. */
    noUnfurl?: boolean;
  },
) => {
  const form = {
    channel: input.channel,
    text: input.text,
    blocks: JSON.stringify(input.blocks),
    ...(input.threadTs && { thread_ts: input.threadTs }),
    ...(input.noUnfurl && {
      unfurl_links: "false",
      unfurl_media: "false",
      unfurl_app_links: "false",
    }),
  };
  if (input.iconUrl && !iconlessMemoized(botToken)) {
    try {
      // Same missing_scope fallback as postMessage — the card must land
      // even on an install predating `chat:write.customize`.
      return await slackCall(
        "chat.postMessage",
        { token: botToken, form: { ...form, icon_url: input.iconUrl } },
        postMessageResponse,
      );
    } catch (err) {
      if (!(err instanceof SlackApiError) || err.code !== "missing_scope") {
        throw err;
      }
      iconlessBotTokens.set(botToken, Date.now());
    }
  }
  return slackCall(
    "chat.postMessage",
    { token: botToken, form },
    postMessageResponse,
  );
};

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
  input: {
    channel: string;
    ts: string;
    text: string;
    blocks?: unknown[];
    /** The message's files, replacing the ones it has (`chat.update`'s
     *  `file_ids`): uploaded privately first (`uploadFiles` without a
     *  channel). `[]` detaches them (a settled bulk card drops its table;
     *  Slack documents the parameter, not an empty list, so the settle
     *  path relies on Slack's observed behavior). */
    fileIds?: readonly string[];
  },
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
        ...(input.fileIds && { file_ids: JSON.stringify(input.fileIds) }),
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

/** A message only `user` sees (`chat.postEphemeral`): how a click's refusal
 * reaches the clicker without rewriting the card everyone shares. `text` is
 * the caller's already-escaped mrkdwn. `threadTs` puts it inside a thread
 * (a refused Stop answers in the thread whose loader it clicked). */
export const postEphemeral = (
  botToken: string,
  input: { channel: string; user: string; text: string; threadTs?: string },
) =>
  slackCall(
    "chat.postEphemeral",
    {
      token: botToken,
      form: {
        channel: input.channel,
        user: input.user,
        text: input.text,
        ...(input.threadTs && { thread_ts: input.threadTs }),
      },
    },
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

// ── File upload (the agent's send_file → the thread) ────────────────────────

const uploadUrlResponse = z.object({
  upload_url: z.string().min(1),
  file_id: z.string().min(1),
});

const completeUploadResponse = z.object({
  files: z.array(z.object({ id: z.string().min(1) })),
});

/** The single POST of file bytes to a minted upload URL. */
const UPLOAD_TIMEOUT_MS = 60_000;

/**
 * Where minted upload URLs may point. Slack mints them on
 * `files.slack.com`; the bytes we POST there are the agent's own file, not a
 * credential — but a control plane that POSTs tenant data to whatever URL an
 * API answer names is one compromised edge away from an exfiltration proxy,
 * so the host is pinned like every other Slack destination. When
 * SLACK_API_BASE_URL points at a fake server (the test seam), that exact
 * origin is the allowed one.
 */
export const isSlackUploadUrl = (raw: string): boolean => {
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
  return host === "files.slack.com" || host.endsWith(".files.slack.com");
};

/** Slack's own per-file ceiling (1 GB); our callers cap far lower, this is
 * the wire's last belt. */
export const SLACK_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

export interface SlackUploadFile {
  name: string;
  bytes: Uint8Array;
  /** Slack's display title for the file (defaults to the name). */
  title?: string;
}

/**
 * Share files into a channel/thread as ONE message — Slack's three-step
 * external upload: mint a URL per file, POST each file's bytes, then a
 * single `files.completeUploadExternal` naming every file id. One
 * completion = one share message, so a turn's N files land as a single
 * post under the answer, not N notifications. `initialComment` is the
 * share message's text (PRE-ESCAPED by the caller, like postMessage).
 *
 * NOT retried at the HTTP layer beyond what `slackCall` does for 429s: the
 * completion is a create (a 5xx after commit would double-share), and a
 * failed byte POST fails the whole share — the caller decides what to say.
 *
 * Refusals arrive as `SlackApiError` with Slack's code verbatim; the caller
 * maps the DETERMINISTIC ones (`missing_scope`, `file_uploads_disabled`,
 * `file_type_not_allowed`, …) to its degrade path. `threadTs` must be the
 * PARENT's ts (Slack's rule for replies).
 */
export const uploadFiles = async (
  botToken: string,
  input: {
    /** Where the files are shared as one message. Omitted: the files stay
     *  private to the bot and nothing is posted (Slack's documented
     *  behavior), ready to attach to an existing message by id
     *  (`updateBlocksMessage`'s `fileIds`). */
    channel?: string;
    threadTs?: string;
    initialComment?: string;
    files: readonly SlackUploadFile[];
  },
): Promise<{ fileIds: string[] }> => {
  if (input.files.length === 0) return { fileIds: [] };
  const minted: { id: string; title?: string }[] = [];
  for (const file of input.files) {
    if (
      file.bytes.byteLength === 0 ||
      file.bytes.byteLength > SLACK_MAX_UPLOAD_BYTES
    ) {
      throw new SlackApiError(
        "files.getUploadURLExternal",
        "invalid_arguments",
      );
    }
    const ticket = await slackCall(
      "files.getUploadURLExternal",
      {
        token: botToken,
        form: { filename: file.name, length: String(file.bytes.byteLength) },
      },
      uploadUrlResponse,
    );
    if (!isSlackUploadUrl(ticket.upload_url)) {
      throw new Error("Slack minted an upload URL outside its own hosts");
    }
    // Raw bytes; no Authorization — the minted URL is its own credential.
    // `redirect: "manual"` (the download path's rule): the host pin above
    // covers the URL Slack minted, and a redirect would re-POST the tenant's
    // bytes to whatever Location says. Slack does not redirect uploads; a
    // 3xx here is a failed share, not a hop to follow.
    const put = await fetch(ticket.upload_url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      // A fresh ArrayBuffer-backed copy: the DOM `BodyInit` typing rejects a
      // Uint8Array over a SharedArrayBuffer, and a Node Buffer's pooled slab
      // must not leak its neighbours into the request anyway.
      body: new Blob([Uint8Array.from(file.bytes)]),
      redirect: "manual",
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    await put.body?.cancel().catch(() => {});
    if (!put.ok) {
      throw new Error(`Slack upload answered HTTP ${put.status}`);
    }
    minted.push({
      id: ticket.file_id,
      ...(file.title !== undefined && { title: file.title }),
    });
  }
  const done = await slackCall(
    "files.completeUploadExternal",
    {
      token: botToken,
      form: {
        files: JSON.stringify(minted),
        ...(input.channel && { channel_id: input.channel }),
        ...(input.threadTs && { thread_ts: input.threadTs }),
        ...(input.initialComment && { initial_comment: input.initialComment }),
      },
    },
    completeUploadResponse,
  );
  return { fileIds: done.files.map((f) => f.id) };
};

const fileSharesResponse = z.object({
  file: z
    .object({
      shares: z
        .object({
          public: z
            .record(z.string(), z.array(z.object({ ts: z.string().min(1) })))
            .optional(),
          private: z
            .record(z.string(), z.array(z.object({ ts: z.string().min(1) })))
            .optional(),
        })
        .loose()
        .optional(),
    })
    .loose(),
});

/** How long the share's message ts may take to appear on the file. */
const SHARE_TS_TRIES = 15;
const SHARE_TS_DELAY_MS = 300;

/**
 * The share POSTED its message, but Slack never said which one (no
 * `files:read` to read it back, or the share never showed up on the file).
 * The card is in the channel: the caller must NOT post it again.
 */
export class SharedMessageUnknownError extends Error {
  constructor(readonly cause: unknown) {
    super("Slack shared the file but its message could not be read back");
    this.name = "SharedMessageUnknownError";
  }
}

/**
 * ONE message carrying Block Kit blocks AND one file: an approval card with
 * its CSV, which Slack shows under the card, collapsed and scrollable.
 *
 * Only a file shared WITH its message shows on it. A file attached later
 * (`chat.update` `file_ids`) is accepted and linked, but the message never
 * lists it, so Slack shows nothing (measured live).
 *
 * Slack's upload never answers with the message ts, so it is read back from
 * the file's shares. Failures split in two, and the split is what keeps a
 * card from ever posting twice:
 * - before the share completes (upload refused, bytes rejected): plain
 *   `SlackApiError` / `Error`, nothing was posted, the caller posts the card
 *   without the file;
 * - after it completes: `SharedMessageUnknownError`, the card IS posted, the
 *   caller must not post again.
 */
export const shareFileWithBlocks = async (
  botToken: string,
  input: {
    channel: string;
    threadTs?: string;
    blocks: unknown[];
    file: SlackUploadFile;
  },
): Promise<{ channel: string; ts: string }> => {
  const bytes = input.file.bytes;
  if (bytes.byteLength === 0 || bytes.byteLength > SLACK_MAX_UPLOAD_BYTES) {
    throw new SlackApiError("files.getUploadURLExternal", "invalid_arguments");
  }
  const ticket = await slackCall(
    "files.getUploadURLExternal",
    {
      token: botToken,
      form: { filename: input.file.name, length: String(bytes.byteLength) },
    },
    uploadUrlResponse,
  );
  if (!isSlackUploadUrl(ticket.upload_url)) {
    throw new Error("Slack minted an upload URL outside its own hosts");
  }
  // Same rules as `uploadFiles`: raw bytes, no bearer, no redirects.
  const put = await fetch(ticket.upload_url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Blob([Uint8Array.from(bytes)]),
    redirect: "manual",
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  await put.body?.cancel().catch(() => {});
  if (!put.ok) throw new Error(`Slack upload answered HTTP ${put.status}`);
  await slackCall(
    "files.completeUploadExternal",
    {
      token: botToken,
      form: {
        files: JSON.stringify([
          { id: ticket.file_id, title: input.file.title ?? input.file.name },
        ]),
        channel_id: input.channel,
        ...(input.threadTs && { thread_ts: input.threadTs }),
        blocks: JSON.stringify(input.blocks),
      },
    },
    completeUploadResponse,
  );
  // From here the card is in the channel: every failure is "posted, ts
  // unknown", never a reason to post again.
  try {
    for (let i = 0; i < SHARE_TS_TRIES; i++) {
      const info = await slackCall(
        "files.info",
        { token: botToken, form: { file: ticket.file_id }, retry5xx: true },
        fileSharesResponse,
      );
      const shares = info.file.shares;
      const ts =
        shares?.public?.[input.channel]?.[0]?.ts ??
        shares?.private?.[input.channel]?.[0]?.ts;
      if (ts) return { channel: input.channel, ts };
      await new Promise((r) => setTimeout(r, SHARE_TS_DELAY_MS));
    }
    throw new Error("the share never appeared on the file");
  } catch (err) {
    throw new SharedMessageUnknownError(err);
  }
};

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
    /** True for an app's bot user. The guest lane's app arm CONFIRMS the
     * wire's classification against this (an event said `bot_id`; the
     * directory must agree) - the same field the recipient search labels
     * apps with. */
    is_bot: z.boolean().optional(),
    profile: z
      .object({
        email: z.string().optional(),
        display_name: z.string().optional(),
        /** Where a manifest rename lands, ASYNCHRONOUSLY - the field the
         * teardown polls to confirm the tombstone before deleting. */
        real_name: z.string().optional(),
        /** Avatar URLs (Slack CDN), smallest to largest. */
        image_48: z.string().optional(),
        image_72: z.string().optional(),
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

const botsInfoResponse = z.object({
  bot: z.object({
    /** The app's PROFILE icon — the one set on the app's settings page
     * (Display Information). Slack serves its generic plugin marks here
     * until an icon is uploaded; `isSlackAppIconUrl` tells them apart. */
    icons: z
      .object({
        image_48: z.string().optional(),
        image_72: z.string().optional(),
      })
      .optional(),
  }),
});

/** An app's bot record — its profile icon. Needs the bot token's
 * `users:read` (in the manifest from day one). `botId` is the `bot_id`
 * `authTest` answers for the app's own bot token. */
export const botsInfo = (botToken: string, botId: string) =>
  slackCall(
    "bots.info",
    { token: botToken, form: { bot: botId }, retry5xx: true },
    botsInfoResponse,
  );

/**
 * Whether a `bots.info` icon URL is an icon someone UPLOADED, and so the one
 * host set the server may download it from. Uploads are served from Slack's
 * avatar CDN; the stock marks an icon-less app answers with
 * (`a.slack-edge.com/.../img/plugins/app/bot_48.png`, observed live) are not,
 * so they never pass. When SLACK_CDN_BASE_URL points at a fake server (the
 * test seam), that exact origin is the allowed one.
 */
export const isSlackAppIconUrl = (raw: string): boolean => {
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
  return (
    url.protocol === "https:" &&
    ["avatars.slack-edge.com", "ca.slack-edge.com"].includes(
      url.hostname.toLowerCase(),
    )
  );
};

/**
 * Download an uploaded app icon (public, so no token rides along). The URL
 * comes from a Slack answer, but the server fetching it must never be
 * steerable elsewhere: `isSlackAppIconUrl` hosts only, no redirects, a
 * timeout, and `maxBytes` enforced mid-stream. Throws on any refusal.
 */
export const downloadSlackAppIcon = async (
  url: string,
  maxBytes: number,
): Promise<Buffer> => {
  if (!isSlackAppIconUrl(url)) throw new Error("not a Slack app icon URL");
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`app icon download answered HTTP ${response.status}`);
  }
  const body = await readCappedBinaryBody(response, maxBytes);
  if (!body.ok) throw new Error(`app icon download ${body.reason}`);
  return body.bytes;
};

const usersListResponse = z.object({
  members: z.array(
    z.object({
      id: z.string().min(1),
      team_id: z.string().optional(),
      name: z.string().optional(),
      deleted: z.boolean().optional(),
      is_bot: z.boolean().optional(),
      is_restricted: z.boolean().optional(),
      is_ultra_restricted: z.boolean().optional(),
      is_stranger: z.boolean().optional(),
      profile: z
        .object({
          display_name: z.string().optional(),
          real_name: z.string().optional(),
        })
        .optional(),
    }),
  ),
  response_metadata: z
    .object({ next_cursor: z.string().optional() })
    .optional(),
});

/**
 * One page of the workspace's member roster — the `find_recipient` tool's
 * people universe. Needs `users:read` (in the manifest from day one).
 * Cursor-paginated; the CALLER owns the loop and its page budget so a
 * pathological workspace can't spin this wrapper forever.
 */
export const usersList = (
  botToken: string,
  input: { cursor?: string; limit?: number } = {},
) =>
  slackCall(
    "users.list",
    {
      token: botToken,
      form: {
        limit: String(input.limit ?? 200),
        ...(input.cursor && { cursor: input.cursor }),
      },
      retry5xx: true,
    },
    usersListResponse,
  );

const conversationsListResponse = z.object({
  channels: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      is_member: z.boolean().optional(),
      is_private: z.boolean().optional(),
      is_archived: z.boolean().optional(),
    }),
  ),
  response_metadata: z
    .object({ next_cursor: z.string().optional() })
    .optional(),
});

/**
 * One page of the workspace's channels — read-only discovery for
 * `find_recipient` ("which channels exist / am I in?"). Sees exactly what
 * `channels:read` + `groups:read` grant: public channels, plus private ones
 * the bot was invited to. Same caller-owned cursor rule as `usersList`.
 */
export const conversationsList = (
  botToken: string,
  input: { cursor?: string; limit?: number } = {},
) =>
  slackCall(
    "conversations.list",
    {
      token: botToken,
      form: {
        types: "public_channel,private_channel",
        exclude_archived: "true",
        limit: String(input.limit ?? 200),
        ...(input.cursor && { cursor: input.cursor }),
      },
      retry5xx: true,
    },
    conversationsListResponse,
  );

// ── A person's own token (xoxp): read-only, for the read tool ──────────────

const userConversation = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  is_channel: z.boolean().optional(),
  is_group: z.boolean().optional(),
  is_im: z.boolean().optional(),
  is_mpim: z.boolean().optional(),
  is_private: z.boolean().optional(),
  is_archived: z.boolean().optional(),
  /** The other person, on a 1:1 DM. */
  user: z.string().optional(),
});
export type SlackUserConversation = z.infer<typeof userConversation>;

/**
 * One page of the conversations the TOKEN'S USER is a member of
 * (`users.conversations`): channels, private channels, DMs and group DMs.
 * With a user token this is exactly "what this person can see" - the read
 * picker's universe. Scopes: channels:read, groups:read, im:read, mpim:read.
 */
export const usersConversations = (
  userToken: string,
  input: { cursor?: string; limit?: number } = {},
) =>
  slackCall(
    "users.conversations",
    {
      token: userToken,
      form: {
        types: "public_channel,private_channel,im,mpim",
        exclude_archived: "true",
        limit: String(input.limit ?? 200),
        ...(input.cursor && { cursor: input.cursor }),
      },
      retry5xx: true,
    },
    z.object({
      channels: z.array(userConversation),
      response_metadata: z
        .object({ next_cursor: z.string().optional() })
        .optional(),
    }),
  );

/**
 * One conversation as the TOKEN'S USER sees it (`conversations.info` with a
 * user token) - Slack answers only for conversations that person can see.
 * Same shape as `usersConversations` rows, plus `is_member` for channels.
 */
export const userConversationInfo = (userToken: string, channelId: string) =>
  slackCall(
    "conversations.info",
    { token: userToken, form: { channel: channelId }, retry5xx: true },
    z.object({
      channel: userConversation.extend({
        is_member: z.boolean().optional(),
      }),
    }),
  );

const historyMessage = z.object({
  ts: z.string().min(1),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  username: z.string().optional(),
  subtype: z.string().optional(),
  text: z.string().optional(),
  thread_ts: z.string().optional(),
  /** How many replies sit in this message's thread. */
  reply_count: z.number().optional(),
  /** Who answered in this message's thread (the agent replies there). */
  reply_users: z.array(z.string()).optional(),
  /** The posting APP (a bot post carries no `user`): how the agent
   * recognizes its own posts. */
  app_id: z.string().optional(),
});
export type SlackHistoryMessage = z.infer<typeof historyMessage>;

const historyResponse = z.object({
  messages: z.array(historyMessage),
  has_more: z.boolean().optional(),
});

/**
 * One page of a conversation's history, newest first. Works with any token
 * that can see the conversation (a user token: anything its user is in).
 * `oldest` is a Slack ts (exclusive lower bound). Read-only: 5xx-retried.
 * Also feeds the point-of-contact reply judge its context (bot token).
 */
export const conversationsHistory = (
  token: string,
  input: { channel: string; oldest?: string; latest?: string; limit?: number },
) =>
  slackCall(
    "conversations.history",
    {
      token,
      form: {
        channel: input.channel,
        limit: String(input.limit ?? 50),
        ...(input.oldest && { oldest: input.oldest }),
        // Exclusive upper bound: pass the oldest ts of the previous page to
        // walk backwards through the whole history.
        ...(input.latest && { latest: input.latest }),
      },
      retry5xx: true,
    },
    historyResponse,
  );

/** One thread's messages, parent first. Same rules as history. */
export const conversationsReplies = (
  token: string,
  input: { channel: string; ts: string; limit?: number },
) =>
  slackCall(
    "conversations.replies",
    {
      token,
      form: {
        channel: input.channel,
        ts: input.ts,
        limit: String(input.limit ?? 50),
      },
      retry5xx: true,
    },
    historyResponse,
  );

/**
 * Revoke a token at Slack (`auth.revoke`) - the disconnect's provider half,
 * so a disconnected person's token stops working at Slack too, not just in
 * our table. Idempotent from our side: an already-dead token refuses with
 * `invalid_auth`/`token_revoked`, which the caller treats as done.
 */
export const authRevoke = (token: string) =>
  slackCall(
    "auth.revoke",
    { token, retry5xx: true },
    z.object({ revoked: z.boolean().optional() }),
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
 * A channel's display name and the bot's own membership. The name feeds the
 * reach card's "#channel" label (display only - matching stays on the id);
 * `is_member` feeds the approve-time subject recheck (a card approved after
 * the bot left the channel must not record a settlement). Best-effort at the
 * callers: a private channel the token cannot read answers an error they
 * swallow into the bare id / a fail-open verdict.
 */
export const conversationsInfo = (
  botToken: string,
  channelId: string,
  options: { signal?: AbortSignal } = {},
) =>
  slackCall(
    "conversations.info",
    {
      token: botToken,
      form: { channel: channelId },
      retry5xx: true,
      signal: options.signal,
    },
    z.object({
      channel: z.object({
        id: z.string().min(1),
        name: z.string().optional(),
        is_member: z.boolean().optional(),
        is_archived: z.boolean().optional(),
      }),
    }),
  );

/**
 * A channel's member ids (`conversations.members`, docs-verified 2026-09-08:
 * `members: string[]` + `response_metadata.next_cursor`; scopes
 * `channels:read` / `groups:read`, both in the manifest). Feeds the room's
 * APP roster for the mention seam - which bot users a thread may tag from
 * its first turn. Same caller-owned cursor rule as `usersList`.
 */
export const conversationsMembers = (
  botToken: string,
  input: { channel: string; cursor?: string; limit?: number },
) =>
  slackCall(
    "conversations.members",
    {
      token: botToken,
      form: {
        channel: input.channel,
        limit: String(input.limit ?? 200),
        ...(input.cursor && { cursor: input.cursor }),
      },
      retry5xx: true,
    },
    z.object({
      members: z.array(z.string().min(1)),
      response_metadata: z
        .object({ next_cursor: z.string().optional() })
        .optional(),
    }),
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

/**
 * The USER-scope-only exchange ("Connect your Slack"): when the authorize
 * URL asks only `user_scope`, Slack returns NO bot token and no
 * `bot_user_id` at the top level - the person's token rides in
 * `authed_user`. A separate schema, so the bot install's strict one (which
 * must refuse a response with no bot token) stays as it is.
 */
const oauthUserAccessResponse = z.object({
  team: z.object({ id: z.string().min(1) }),
  authed_user: z.object({
    id: z.string().min(1),
    access_token: z.string().min(1),
  }),
});

export const oauthUserAccess = (input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}) =>
  slackCall(
    "oauth.v2.access",
    {
      basicAuth: { user: input.clientId, pass: input.clientSecret },
      form: { code: input.code, redirect_uri: input.redirectUri },
    },
    oauthUserAccessResponse,
  );

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
