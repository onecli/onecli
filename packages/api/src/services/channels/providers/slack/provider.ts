import { isDeadCredentialError } from "@onecli/channels";
import { ServiceError } from "../../../errors";
import { logger } from "../../../../lib/logger";
import { DeadIntegrationCredentialError } from "../../errors";
import type {
  ChannelProvider,
  PresenceIdentity,
  WaitingMessage,
} from "../../types";
import { dispatchSlackEvent } from "./dispatch";
import { invalidateInboundPresence } from "./inbound-cache";
import { slackSharedApp } from "./shared-install-service";
import { slackReach } from "./reach-card";
import { slackActionApprovalCard } from "./action-approval-card";
import { settleSlackGatewayApprovalCard } from "./gateway-approval-card";
import {
  BOT_EVENTS,
  botScopesFor,
  buildAgentManifest,
  USER_READ_SCOPES,
  withAgentBotEvents,
  withSyncedAppName,
  withTombstoneName,
  withUserReadScopes,
} from "./manifest";
import {
  agentsSessionsSetStatus,
  conversationsList,
  conversationsOpen,
  decodeSlackTokens,
  deleteMessage,
  escapeSlackText,
  clampLabel,
  followUpSendNowButton,
  groupThreadId,
  markdownToMrkdwn,
  postBlocksMessage,
  postMessage,
  usersList,
  SLACK_TASK_TITLE_MAX,
  updateBlocksMessage,
  authTest,
  downloadPrivateFile,
  filesInfo,
  manifestCreate,
  manifestDelete,
  manifestExport,
  manifestUpdate,
  appsUninstall,
  oauthAccess,
  reactionsAdd,
  reactionsRemove,
  rotateConfigToken,
  SlackApiError,
  turnStopButton,
  usersInfo,
  botsInfo,
  downloadSlackAppIcon,
  isSlackAppIconUrl,
  connectionsOpen,
} from "@onecli/channels/slack";
import {
  parseSlackIntegrationCredentials,
  parseSlackPresenceCredentials,
  type SlackIntegrationCredentials,
  type SlackPresenceCredentials,
} from "./types";

/**
 * Slack's entry in the channel-provider registry — everything the generic
 * services dispatch to it, and nothing Slack-shaped escaping it.
 */

/** Rotate when this close to expiry, so an in-flight create never races the
 * 12h cliff with a token about to die under it. */
const ROTATE_SLACK_SECONDS = 10 * 60;

/**
 * `tooling.tokens.rotate` refusals that name the REFRESH HALF itself as
 * unusable — deterministic, never worth a retry, so a stored pair answering
 * one of these is dead and the org must re-paste.
 *
 * `internal_error` is deliberately absent: Slack documents it on this method
 * as "likely a transient issue on our end", yet it is ALSO what a refresh
 * token that was already consumed elsewhere answers (a well-formed but spent
 * token, as other integrators report; malformed ones answer
 * `invalid_refresh_token` — probed live 2026-09-09). The wire cannot tell
 * those apart, so the rotation path keeps the pair and retries, and lets the
 * access half's own `exp` settle it: a pair still refused once nothing usable
 * is left is dead (see `rotateIntegrationCredential`).
 */
/** Roster paging bound for `listRecipients` — Slack pages users.list and
 * conversations.list at up to 1000 (docs recommend ≤200); 25 pages covers
 * any workspace that fits a per-agent app. */
const RECIPIENT_PAGES = 25;

const DEAD_REFRESH_TOKEN_CODES: ReadonlySet<string> = new Set([
  "invalid_refresh_token",
  "token_revoked",
  "token_expired",
  "invalid_auth",
  "account_inactive",
]);

/**
 * What a PASTED refresh token answers when it has already been spent: the
 * pair was rotated by an earlier paste here or by another tool, or the user
 * regenerated on api.slack.com (which invalidates the previous pair). On the
 * paste path there is no stored access half to fall back on, so both codes
 * mean one thing — generate a fresh pair — and the message says so instead of
 * echoing Slack's opaque code alone.
 */
const SPENT_PASTED_TOKEN_CODES: ReadonlySet<string> = new Set([
  "invalid_refresh_token",
  "internal_error",
]);

/**
 * `apps.connections.open` refusals that are Slack's own outage, not a verdict
 * on the pasted app-level token (from the method's documented error table):
 * the paste check reads these as "try again", never "wrong token".
 */
const TRANSIENT_CONNECTIONS_OPEN_CODES: ReadonlySet<string> = new Set([
  "fatal_error",
  "internal_error",
  "ratelimited",
  "request_timeout",
  "service_unavailable",
]);

/** The prefix Slack gives app-level tokens of an app with app-level token
 * rotation on: they expire after 12 hours, and nothing here refreshes them. */
const ROTATING_APP_TOKEN_PREFIX = "xoxe.xapp-";

/**
 * Prove a pasted app-level token can hold a Socket Mode connection before it
 * is stored: minting a socket URL takes a live token carrying
 * `connections:write`, exactly what the adapter will need. The URL is
 * single-use and discarded unopened. No raw provider text reaches the
 * message: an upstream body may echo the token.
 */
const assertAppTokenConnects = async (appToken: string): Promise<void> => {
  try {
    await connectionsOpen(appToken);
  } catch (error) {
    const refused =
      error instanceof SlackApiError &&
      !TRANSIENT_CONNECTIONS_OPEN_CODES.has(error.code);
    throw new ServiceError(
      "UNPROCESSABLE",
      refused
        ? "Slack didn't accept that app-level token. Generate one for this app with the connections:write scope and paste it again."
        : "Couldn't reach Slack to check the app-level token. Try again in a moment.",
    );
  }
};

/**
 * A socket app a consent install left one step short: the OAuth exchange
 * stored the bot token (which needs the app's own client pair) and no
 * app-level token exists yet. A detached app still holds the app-level token
 * of its earlier attachment, so it never matches.
 */
const awaitsAppToken = (creds: SlackPresenceCredentials): boolean =>
  creds.clientId !== undefined &&
  creds.botToken !== undefined &&
  creds.appToken === undefined;

/** The stored shape, minted from a rotate answer — both the paste path and
 * the rotation path persist exactly this. */
const rotatedCredential = (
  rotated: Awaited<ReturnType<typeof rotateConfigToken>>,
) => ({
  tenant: { externalId: rotated.team_id, name: null },
  credentialsJson: JSON.stringify({
    accessToken: rotated.token,
    refreshToken: rotated.refresh_token,
    expiresAt: rotated.exp,
  } satisfies SlackIntegrationCredentials),
});

const identityFromAuthTest = (probe: {
  team_id: string;
  team?: string | undefined;
  user_id: string;
  user?: string | undefined;
}): PresenceIdentity => ({
  tenant: { externalId: probe.team_id, name: probe.team ?? null },
  identityRef: probe.user_id,
  identityName: probe.user ?? null,
});

const mergedJson = (
  existing: SlackPresenceCredentials,
  update: SlackPresenceCredentials,
): string => JSON.stringify({ ...existing, ...update });

/**
 * `apps.uninstall` refusals about the CLIENT credential pair rather than the
 * bot token. Together with the dead-token codes (`isDeadCredentialError`),
 * these say "this call can never succeed with what we hold", which is not the
 * same as "the app is gone": the snapshot stays for manual reconciliation.
 */
const UNINSTALL_CLIENT_CREDENTIAL_CODES: ReadonlySet<string> = new Set([
  "invalid_client_id",
  "bad_client_secret",
]);

/** Basic Information — where the app-level token is generated and where
 * "Install to Workspace" lives. */
const appSettingsUrl = (appId: string): string =>
  `https://api.slack.com/apps/${encodeURIComponent(appId)}/general`;

const log = logger.child({ component: "slack-provider" });

/**
 * The narration plan's heading. Deliberately plain: it sits above the task
 * rows for the whole turn, so it describes the ACT of working, never a
 * specific step (the rows do that).
 */
const NARRATION_PLAN_TITLE = "Working on your request";

/**
 * One waiting message as a card row: what the person wrote, on one line,
 * with their Send now beside it when they are a linked person. The text is
 * theirs and untrusted: flattened to one line, escaped (so `<!channel>` or
 * a link stays text), then bounded. A message of files alone has no words
 * to quote (a send must carry text or files), so it says so.
 */
const waitingRow = (message: WaitingMessage) => {
  const words = message.text.replace(/\s+/gu, " ").trim();
  const quote = words
    ? `\u201c${clampLabel(escapeSlackText(words))}\u201d`
    : "_a message with files_";
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `:hourglass_flowing_sand: Waiting: ${quote}`,
    },
    ...(message.authorExternalUserId && {
      accessory: followUpSendNowButton(
        message.id,
        message.authorExternalUserId,
      ),
    }),
  };
};

export const slackProvider: ChannelProvider = {
  id: "slack",
  displayName: "Slack",

  // The one interpreter for both transports (dispatch.ts) — the neutral
  // dispatch hook the generic ingest door calls by registry lookup.
  dispatchInbound: dispatchSlackEvent,

  // A removed app must stop being admitted by the events route at once, not
  // after the verification cache's TTL (inbound-cache.ts).
  onPresenceRemoved: ({ externalId }) => invalidateInboundPresence(externalId),

  // The reach facet (reach-card.ts): the space key behind a group-thread
  // address, the guest-speaker probe, and the platform-composed owner-DM
  // card - everything provider-shaped about space grants in one home.
  reach: slackReach,

  // The one-shot action-approval card (action-approval-card.ts): the
  // owner-DM prompt for a held privileged agent action.
  actionApprovalCard: slackActionApprovalCard,

  // A gateway approval card rewritten from the control plane (a held
  // request the person's newer message superseded).
  settleGatewayApprovalCard: settleSlackGatewayApprovalCard,

  // The deployment-owned shared app (SLACK_SHARED_* env): onboarding +
  // config-token-free agent-app minting, reached only through this facet.
  sharedApp: slackSharedApp,

  async connectIntegration(rawCredential) {
    const pasted = rawCredential.trim();
    // Slack's "Your App Configuration Tokens" page has two Copy buttons. The
    // ACCESS token is `xoxe.xoxp-…`, the REFRESH token `xoxe-…` — both start
    // with `xoxe`, and a real access token sent as `refresh_token` answers an
    // opaque `internal_error` (the live report behind this fix, 2026-09-09),
    // the same code a spent refresh token answers. Tell the two apart HERE,
    // before any Slack call, or the user gets "generate a new one" advice for
    // a copy-paste mix-up.
    if (pasted.startsWith("xoxe.")) {
      throw new ServiceError(
        "UNPROCESSABLE",
        'That is the Access Token. Paste the Refresh Token instead: the other Copy button on Slack\'s "Your App Configuration Tokens" page (it starts with "xoxe-").',
      );
    }
    // A loose family check so the other common mistake — pasting a bot or
    // user token — gets a real message instead of `invalid_refresh_token`.
    if (!pasted.startsWith("xoxe-")) {
      throw new ServiceError(
        "UNPROCESSABLE",
        'That doesn\'t look like an app-configuration refresh token (it should start with "xoxe-"). Copy the Refresh Token from Slack\'s "Your App Configuration Tokens" page.',
      );
    }
    // Rotation IS the validation: it proves the token works, names the
    // workspace, and replaces the (single-use) pasted pair with a fresh one.
    try {
      return rotatedCredential(await rotateConfigToken(pasted));
    } catch (err) {
      if (
        err instanceof SlackApiError &&
        SPENT_PASTED_TOKEN_CODES.has(err.code)
      ) {
        throw new ServiceError(
          "UNPROCESSABLE",
          `Slack refused this refresh token (${err.code}). A refresh token works once: if it was pasted here before, rotated by another tool, or regenerated on api.slack.com, it is spent. Generate a new token under "Your App Configuration Tokens" and paste the new Refresh Token.`,
        );
      }
      // Every other refusal keeps Slack's own code verbatim (the generic 422).
      throw err;
    }
  },

  async rotateIntegrationCredential(credentialsJson, options) {
    let stored: SlackIntegrationCredentials;
    try {
      stored = parseSlackIntegrationCredentials(credentialsJson);
    } catch {
      // A blob that no longer parses cannot be rotated from, ever. The parse
      // error is deliberately NOT attached as the cause: a JSON.parse
      // SyntaxError echoes a slice of its input, and this input is the
      // decrypted credential.
      throw new DeadIntegrationCredentialError("slack", "unreadable");
    }
    const now = Math.floor(Date.now() / 1000);
    if (!options?.force && stored.expiresAt - now > ROTATE_SLACK_SECONDS) {
      return null;
    }
    try {
      return rotatedCredential(await rotateConfigToken(stored.refreshToken));
    } catch (err) {
      if (
        err instanceof SlackApiError &&
        DEAD_REFRESH_TOKEN_CODES.has(err.code)
      ) {
        throw new DeadIntegrationCredentialError("slack", err.code, {
          cause: err,
        });
      }
      // Anything else — `internal_error`, `service_unavailable`, a 5xx, a
      // timeout — may pass on the next attempt. While the access half is
      // still live the caller keeps the pair and retries later; once it has
      // expired there is nothing left to use, so the same refusal is final.
      if (now >= stored.expiresAt) {
        throw new DeadIntegrationCredentialError(
          "slack",
          err instanceof SlackApiError ? err.code : "refused_after_expiry",
          { cause: err },
        );
      }
      throw err;
    }
  },

  async createManagedPresence({
    accessToken,
    agentName,
    transport,
    publicApiUrl,
    oauthState,
    owner,
  }) {
    const manifest = buildAgentManifest({
      agentName,
      transport,
      publicApiUrl,
      owner,
    });
    const created = await manifestCreate(accessToken, manifest);
    const credentialsJson = JSON.stringify({
      clientId: created.credentials.client_id,
      clientSecret: created.credentials.client_secret,
      signingSecret: created.credentials.signing_secret,
      // Mirrors buildAgentManifest's redirect rule exactly.
      ...(publicApiUrl && { oauthRedirect: true }),
    } satisfies SlackPresenceCredentials);

    // The prefilled consent URL is the one-click install flow for BOTH
    // transports whenever a state was minted (events always; socket when
    // this deployment has the public HTTPS origin the manifest baked as its
    // redirect). Our signed state rides along so the callback can prove the
    // journey started here.
    const installUrl = oauthState
      ? `${created.oauth_authorize_url}&state=${encodeURIComponent(oauthState)}`
      : null;

    return {
      externalId: created.app_id,
      credentialsJson,
      installUrl,
      settingsUrl: appSettingsUrl(created.app_id),
    };
  },

  async completePresence({ pasted, existingCredentialsJson, transport }) {
    const existing = existingCredentialsJson
      ? parseSlackPresenceCredentials(existingCredentialsJson)
      : {};
    const pastedBotToken = pasted.botToken?.trim() ?? "";
    // An app-token-only paste is the socket arm's second step after a consent
    // install: the bot token arrived through the OAuth exchange (minted by
    // Slack for THIS app's client credentials and fenced to the org's
    // workspace there). Anything else must paste the bot token too.
    const appTokenOnly = !pastedBotToken && transport === "socket";
    const botToken =
      appTokenOnly && awaitsAppToken(existing)
        ? (existing.botToken ?? "")
        : pastedBotToken;
    const appToken = pasted.appToken?.trim() ?? "";
    const signingSecret = pasted.signingSecret?.trim() ?? "";

    if (!botToken.startsWith("xoxb-")) {
      throw new ServiceError(
        "UNPROCESSABLE",
        appTokenOnly
          ? "Install the app in Slack first, then paste the app-level token."
          : 'The Bot User OAuth Token should start with "xoxb-". Copy it from OAuth & Permissions after installing the app.',
      );
    }
    if (transport === "socket") {
      if (appToken.startsWith(ROTATING_APP_TOKEN_PREFIX)) {
        throw new ServiceError(
          "UNPROCESSABLE",
          "That app-level token rotates: Slack expires it after 12 hours, and OneCLI can't refresh it. Slack can't turn rotation off on an app, so use a new app with Token rotation left off.",
        );
      }
      if (!appToken.startsWith("xapp-")) {
        throw new ServiceError(
          "UNPROCESSABLE",
          'The app-level token should start with "xapp-". Generate it under Basic Information → App-Level Tokens with the connections:write scope.',
        );
      }
      // A dead or under-scoped token would leave the agent deaf, and the
      // adapter reads its refusal as the app being removed. Ask Slack now,
      // before anything is stored.
      await assertAppTokenConnects(appToken);
    }

    // The events paste floor has no manifest-create response to remember the
    // signing secret from, and the inbound routes cannot verify a request
    // without it — so on that one path the paste form must carry it.
    if (transport === "events" && !existing.signingSecret && !signingSecret) {
      throw new ServiceError(
        "UNPROCESSABLE",
        "The Signing Secret is required. Copy it from the app's Basic Information page.",
      );
    }

    const probe = await authTest(botToken);
    return {
      identity: identityFromAuthTest(probe),
      credentialsJson: mergedJson(existing, {
        botToken,
        ...(appToken && { appToken }),
        ...(signingSecret && { signingSecret }),
      }),
    };
  },

  async exchangeOAuthCode({ code, redirectUri, credentialsJson }) {
    const existing = parseSlackPresenceCredentials(credentialsJson);
    if (!existing.clientId || !existing.clientSecret) {
      // Only reachable if a callback arrives for a presence the guided
      // create didn't mint — a forged or very stale link.
      throw new ServiceError("UNPROCESSABLE", "This install link is not valid");
    }
    const exchanged = await oauthAccess({
      clientId: existing.clientId,
      clientSecret: existing.clientSecret,
      code,
      redirectUri,
    });
    // `oauth.v2.access` names the workspace and the bot USER ID, but not the
    // bot's handle — and the handle is what a human recognizes ("@yoyo"). We
    // now hold a bot token, so ask. Best-effort: a failure here would mean
    // losing a completed install over a display string.
    const probe = await authTest(exchanged.access_token).catch(() => null);
    return {
      identity: {
        tenant: {
          externalId: exchanged.team.id,
          name: exchanged.team.name ?? null,
        },
        identityRef: exchanged.bot_user_id,
        identityName: probe?.user ?? null,
      },
      credentialsJson: JSON.stringify({
        ...existing,
        // A consent mints a NEW installation: an app-level token kept from an
        // earlier attachment must not ride along, or a re-attached socket app
        // would never read as awaiting its fresh one (`awaitsAppToken`).
        appToken: undefined,
        botToken: exchanged.access_token,
      } satisfies SlackPresenceCredentials),
    };
  },

  async fetchIdentityName({ credentialsJson }) {
    if (!credentialsJson) return null;
    const creds = parseSlackPresenceCredentials(credentialsJson);
    if (!creds.botToken) return null;
    const probe = await authTest(creds.botToken).catch(() => null);
    return probe?.user ?? null;
  },

  async uninstallRemotePresence({ credentialsJson }) {
    let creds: SlackPresenceCredentials;
    try {
      creds = credentialsJson
        ? parseSlackPresenceCredentials(credentialsJson)
        : {};
    } catch {
      return { outcome: "blocked", reason: "unreadable_credentials" };
    }
    if (!creds.botToken || !creds.clientId || !creds.clientSecret) {
      // Pending setup is not evidence of never having been installed in Slack.
      return { outcome: "blocked", reason: "missing_uninstall_credentials" };
    }
    try {
      await appsUninstall({
        botToken: creds.botToken,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
      });
      return { outcome: "uninstalled" };
    } catch (error) {
      // Inactive/revoked authentication is NOT authoritative installation state.
      // Keep the snapshot for manual reconciliation rather than deleting a bot.
      if (
        isDeadCredentialError(error) ||
        (error instanceof SlackApiError &&
          UNINSTALL_CLIENT_CREDENTIAL_CODES.has(error.code))
      ) {
        return {
          outcome: "blocked",
          reason: "uninstall_authorization_required",
        };
      }
      // No raw provider messages: a malformed upstream response may echo secrets.
      return { outcome: "retry", reason: "uninstall_unavailable" };
    }
  },

  isUserCreatedApp({ credentialsJson }) {
    // `apps.manifest.create` returns the client pair for every app the
    // platform creates (the guided arm and the shared-app mint), and every
    // later write merges into that blob. A bot token with NEITHER half is the
    // paste floor's shape: the user made the app at api.slack.com and pasted
    // only its tokens. Half a pair is a shape no path writes, so it proves
    // nothing either way.
    if (!credentialsJson) return false;
    try {
      const creds = parseSlackPresenceCredentials(credentialsJson);
      return (
        creds.botToken !== undefined &&
        creds.clientId === undefined &&
        creds.clientSecret === undefined
      );
    } catch {
      return false;
    }
  },

  awaitsTransportCredential({ credentialsJson }) {
    try {
      return awaitsAppToken(parseSlackPresenceCredentials(credentialsJson));
    } catch {
      return false;
    }
  },

  async renameRemotePresence({ accessToken, externalId }) {
    // Before the uninstall: an uninstalled app answers `app_not_found` here.
    // Cosmetic best effort: Slack copies the name onto the bot user
    // asynchronously and does not guarantee it survives deletion, so nothing
    // waits for propagation.
    const { manifest } = await manifestExport(accessToken, externalId);
    await manifestUpdate(
      accessToken,
      externalId,
      withTombstoneName(manifest, externalId),
    );
  },

  async deleteRemotePresence({ accessToken, externalId }) {
    // Idempotent by contract: the cleanup worker persists "deleted" only
    // AFTER this call returns, so a crash in between replays it. An app that
    // is already gone is the end state this phase wants, not a failure.
    try {
      await manifestDelete(accessToken, externalId);
    } catch (error) {
      if (error instanceof SlackApiError && error.code === "app_not_found") {
        return;
      }
      throw error;
    }
  },

  presenceSettingsUrl({ externalId }) {
    // Scrolled to the "Display Information" card (Slack's own
    // `<a name="display">`), where the app's profile icon is set.
    return `${appSettingsUrl(externalId)}#display`;
  },

  presenceIcon: {
    async read({ credentialsJson }) {
      const { botToken } = parseSlackPresenceCredentials(credentialsJson);
      if (!botToken) throw new Error("presence has no bot token");
      // bots.info is keyed by the bot id, which auth.test answers for the
      // app's own bot token.
      const { bot_id: botId } = await authTest(botToken);
      if (!botId) return null;
      const icons = (await botsInfo(botToken, botId)).bot.icons;
      const url = icons?.image_72 ?? icons?.image_48;
      return url && isSlackAppIconUrl(url) ? url : null;
    },
    download: downloadSlackAppIcon,
  },

  async syncRemotePresenceName({ accessToken, externalId, name }) {
    // Export-then-edit, the tombstone rename's exact shape: rebuilding the
    // manifest fresh could rewrite scopes or URLs on an app that predates
    // the current template. Slack copies the display name onto the bot user
    // asynchronously (~5s); nobody gates on it, so no poll here. The synced
    // variant also moves the generated About text (it embeds the old name),
    // while a customized description stays untouched.
    const { manifest } = await manifestExport(accessToken, externalId);
    await manifestUpdate(
      accessToken,
      externalId,
      withSyncedAppName(manifest, name),
    );
  },

  async enableUserReadAccess({ accessToken, externalId, redirectUrl }) {
    const { manifest } = await manifestExport(accessToken, externalId);
    const next = withUserReadScopes(manifest, redirectUrl);
    if (next) await manifestUpdate(accessToken, externalId, next);
  },

  userReadScopes: USER_READ_SCOPES,

  presenceEvents: {
    current: BOT_EVENTS,
    async sync({ accessToken, externalId }) {
      // Export-then-edit, the rename's shape and for the same reason: a
      // rebuilt manifest could rewrite scopes or URLs on an older app. No
      // write when nothing is missing (an app made from the current
      // template, or one someone already updated by hand).
      const { manifest } = await manifestExport(accessToken, externalId);
      const updated = withAgentBotEvents(manifest);
      if (updated) await manifestUpdate(accessToken, externalId, updated);
    },
  },

  async lookupUserEmail({ credentialsJson, externalUserId }) {
    if (!credentialsJson) return undefined;
    try {
      const creds = parseSlackPresenceCredentials(credentialsJson);
      if (!creds.botToken) return undefined;
      const profile = await usersInfo(creds.botToken, externalUserId);
      return profile.user.profile?.email;
    } catch {
      // "Cannot look them up" and "they do not exist" answer identically:
      // not linkable automatically.
      return undefined;
    }
  },

  async fetchAttachment({ credentialsJson, file, maxBytes }) {
    // The failure shape carries display metadata so the door can mint an
    // honest `failed` chip whatever went wrong.
    const failed = (reason: string) => ({
      ok: false as const,
      name: file.name ?? "file",
      mimeType: file.mimeType ?? "application/octet-stream",
      sizeBytes: file.size ?? 0,
      reason,
    });

    const botToken = credentialsJson
      ? parseSlackPresenceCredentials(credentialsJson).botToken
      : undefined;
    if (!botToken) return failed("no bot credential");

    // A Slack Connect share arrives as a metadata stub — resolve it first.
    let ref = file;
    if (file.needsInfo || !file.url) {
      try {
        const info = await filesInfo(botToken, file.id);
        ref = {
          ...file,
          name: info.file.name ?? file.name,
          mimeType: info.file.mimetype ?? file.mimeType,
          size: info.file.size ?? file.size,
          url: info.file.url_private ?? file.url,
          needsInfo: false,
        };
      } catch {
        return failed("file metadata unavailable");
      }
    }
    if (!ref.url) return failed("no download URL");
    // Refuse KNOWN-oversize files before spending the bytes; the streamed
    // cap below still owns the truth for lying metadata.
    if (typeof ref.size === "number" && ref.size > maxBytes) {
      return { ...failed("file too large"), name: ref.name ?? "file" };
    }

    const download = await downloadPrivateFile(botToken, ref.url, maxBytes);
    if (!download.ok) {
      return {
        ...failed(download.reason),
        name: ref.name ?? "file",
        mimeType: ref.mimeType ?? "application/octet-stream",
        sizeBytes: ref.size ?? 0,
      };
    }
    return {
      ok: true,
      name: ref.name ?? "file",
      // The event's own mimetype wins (Slack detects it at upload); the
      // response header is the fallback for stub shares.
      mimeType:
        ref.mimeType ?? download.contentType ?? "application/octet-stream",
      bytes: download.bytes,
    };
  },

  async addReceiptReaction({ credentialsJson, channel, messageTs, reaction }) {
    const botToken = credentialsJson
      ? parseSlackPresenceCredentials(credentialsJson).botToken
      : undefined;
    if (!botToken) return;
    await reactionsAdd(botToken, {
      channel,
      timestamp: messageTs,
      name: reaction,
    });
  },

  async removeReceiptReaction({
    credentialsJson,
    channel,
    messageTs,
    reaction,
  }) {
    const botToken = credentialsJson
      ? parseSlackPresenceCredentials(credentialsJson).botToken
      : undefined;
    if (!botToken) return;
    await reactionsRemove(botToken, {
      channel,
      timestamp: messageTs,
      name: reaction,
    });
  },

  async sendMessage({ credentialsJson, to, text, mentions }) {
    const { botToken } = parseSlackPresenceCredentials(credentialsJson);
    if (!botToken) throw new Error("presence has no bot token");
    // People AND apps are addressed via their DM channel (conversations.open
    // is idempotent — it returns the existing IM; an app's bot user opens an
    // IM the same way); channels post directly.
    const channel =
      to.kind === "channel"
        ? to.ref
        : (await conversationsOpen(botToken, to.ref)).channel.id;
    // The same renderer the mirror trusts, with the map FROZEN at request
    // time: body @[Name] tokens ping exactly who was resolved when the owner
    // read the card. Tokens without a map entry degrade to plain text.
    const rendered = markdownToMrkdwn(
      text,
      mentions ? { mentions: new Map(mentions) } : undefined,
    );
    const posted = await postMessage(botToken, { channel, text: rendered });
    // The address a reply arrives on (the inbound codec's own shapes): a DM
    // answer comes back as the IM itself; a channel answer that mentions
    // the agent comes back as the thread this post roots.
    return {
      externalThreadId:
        to.kind === "channel"
          ? groupThreadId(posted.channel, posted.ts)
          : posted.channel,
    };
  },

  async listMembers({ credentialsJson, tenantId, selfIdentityRef }) {
    const { botToken } = parseSlackPresenceCredentials(credentialsJson);
    if (!botToken) return [];
    const members: { ref: string; name: string; isApp: boolean }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < RECIPIENT_PAGES; page += 1) {
      const response = await usersList(botToken, { cursor });
      for (const member of response.members) {
        // Deleted members, Slackbot (is_bot false but never a recipient),
        // and the presence's OWN bot user (self-mention = self-invocation,
        // a loop seed) stay invisible. Other bots are APPS — labeled
        // candidates, not silent holes.
        if (
          member.deleted ||
          member.id === "USLACKBOT" ||
          member.id === selfIdentityRef
        ) {
          continue;
        }
        // The tenant fence: same team, never a Slack Connect stranger.
        if (member.team_id !== tenantId || member.is_stranger === true) {
          continue;
        }
        const name =
          member.profile?.display_name ||
          member.profile?.real_name ||
          member.name ||
          "";
        if (!name) continue;
        members.push({ ref: member.id, name, isApp: member.is_bot === true });
      }
      cursor = response.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return members;
  },

  async listChannels({ credentialsJson }) {
    const { botToken } = parseSlackPresenceCredentials(credentialsJson);
    if (!botToken) return [];
    const channels: {
      ref: string;
      name: string;
      member: boolean;
      private: boolean;
    }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < RECIPIENT_PAGES; page += 1) {
      const response = await conversationsList(botToken, { cursor });
      for (const channel of response.channels) {
        if (channel.is_archived || !channel.name) continue;
        channels.push({
          ref: channel.id,
          name: channel.name,
          member: channel.is_member === true,
          private: channel.is_private === true,
        });
      }
      cursor = response.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return channels;
  },

  decodeInboundText({ text, resolveUserName, resolveChannelName }) {
    return decodeSlackTokens(text, resolveUserName, resolveChannelName);
  },

  async setThreadWorkStatus({ credentialsJson, channel, threadTs, working }) {
    const botToken = credentialsJson
      ? parseSlackPresenceCredentials(credentialsJson).botToken
      : undefined;
    // No credential = cannot set the status — THROW (contract: the caller's
    // reaction fallback listens for failure, and a silent return here would
    // record a session receipt with no loader behind it).
    if (!botToken) throw new Error("no bot credential");

    // Slack's native agent loader. A free-text CAPTION beside it is not
    // possible: `agents.sessions.setStatus` documents that "custom loading
    // messages are not supported", and the legacy free-text method
    // (`assistant.threads.setStatus`) now runs through a compatibility
    // bridge onto this same session — VERIFIED LIVE 2026-08-31, it answers
    // `ok: true` and renders nothing. Words in Slack need `chat.startStream`
    // task cards, which is a message, not a status.
    await agentsSessionsSetStatus(botToken, {
      channelId: channel,
      threadTs,
      status: working ? "processing" : "active",
    });
  },

  async narrateThreadWork({
    credentialsJson,
    channel,
    threadTs,
    activities,
    cardTs,
    stoppable,
    waiting,
  }) {
    const botToken = credentialsJson
      ? parseSlackPresenceCredentials(credentialsJson).botToken
      : undefined;
    // Unlike the loader, narration is decoration: a missing credential is
    // "cannot narrate", not a failure the caller must react to.
    if (!botToken) return null;

    // The WHOLE card, every time. `chat.update` replaces the message, so the
    // list is rendered from the turn's full history rather than patched —
    // which is why there is no partial state to reconcile and no row that
    // can be left dangling.
    //
    // Every step but the last is finished by definition: the agent moved on
    // from it. Only the newest is still running.
    //
    // A stoppable card (no native loader, so no native Stop) carries the
    // Stop button under the steps. Re-rendered with the card each time, so
    // it is there from the first step to the last and leaves with the card.
    //
    // Each message waiting to be read is one row between the steps and
    // Stop, its author's Send now beside it (shown to them alone). The row
    // leaves the card the moment the agent reads the message.
    const blocks = [
      {
        type: "plan",
        title: NARRATION_PLAN_TITLE,
        tasks: activities.map((activity, index) => ({
          task_id: `t${index}`,
          title: activity.slice(0, SLACK_TASK_TITLE_MAX),
          status: index === activities.length - 1 ? "in_progress" : "complete",
        })),
      },
      ...waiting.map(waitingRow),
      ...(stoppable ? [{ type: "actions", elements: [turnStopButton] }] : []),
    ];

    try {
      if (cardTs === null) {
        // FIRST step: a plain message. Omitting `threadTs` in a DM is what
        // keeps the card top-level, where the conversation already lives —
        // Slack's streaming methods cannot do this (they answer
        // `invalid_thread_ts` without a root), and threading a DM per turn
        // was the cost this replaces.
        const posted = await postBlocksMessage(botToken, {
          channel,
          text: NARRATION_PLAN_TITLE,
          blocks,
          ...(threadTs === null ? {} : { threadTs }),
        });
        return { cardTs: posted.ts };
      }
      await updateBlocksMessage(botToken, {
        channel,
        ts: cardTs,
        text: NARRATION_PLAN_TITLE,
        blocks,
      });
      return { cardTs };
    } catch (err) {
      // Narration decorates a loader that is already standing, so a refusal
      // costs the words and nothing else. Stable message + Slack's own code,
      // so the rate is measurable in the logs.
      log.info(
        { err: String(err), channel },
        "slack narration refused; native loader stands",
      );
      return null;
    }
  },

  async removeThreadNarration({ credentialsJson, channel, cardTs }) {
    const botToken = credentialsJson
      ? parseSlackPresenceCredentials(credentialsJson).botToken
      : undefined;
    if (!botToken) return;
    try {
      await deleteMessage(botToken, { channel, ts: cardTs });
    } catch (err) {
      // Already gone (`message_not_found`), or a workspace that refuses the
      // delete. Either way the card stands with its steps complete: a worse
      // outcome than removal, but not a broken one.
      log.info(
        { err: String(err), channel },
        "slack narration card left standing",
      );
    }
  },

  buildSetupMaterial({ agentName, transport, publicApiUrl }) {
    return buildAgentManifest({ agentName, transport, publicApiUrl });
  },

  rebuildSetupUrls({
    externalId,
    transport,
    appMode,
    credentialsJson,
    oauthState,
  }) {
    const settingsUrl = appSettingsUrl(externalId);
    if (!credentialsJson || !oauthState) {
      return { installUrl: null, settingsUrl };
    }
    let creds: SlackPresenceCredentials;
    try {
      creds = parseSlackPresenceCredentials(credentialsJson);
    } catch {
      return { installUrl: null, settingsUrl };
    }
    const clientId = creds.clientId;
    if (!clientId) return { installUrl: null, settingsUrl };
    // A socket app installs by consent only when its manifest carries our
    // redirect (created on a public HTTPS origin). Apps from before that
    // keep the token paste. A re-consent on an installed app is harmless:
    // Slack re-issues the bot token, which is how a removed app re-attaches.
    if (transport === "socket" && !creds.oauthRedirect) {
      return { installUrl: null, settingsUrl };
    }
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", clientId);
    // The FULL bot scope list, exactly as the manifest declares it FOR THIS
    // APP'S FLAVOR: the authorize URL's `scope` param is what the install
    // GRANTS — a shorter list here would mint a bot token missing scopes the
    // agent needs.
    url.searchParams.set("scope", botScopesFor(appMode).join(","));
    url.searchParams.set("state", oauthState);
    return { installUrl: url.toString(), settingsUrl };
  },
};
