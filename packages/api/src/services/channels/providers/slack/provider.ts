import { ServiceError } from "../../../errors";
import { logger } from "../../../../lib/logger";
import type { ChannelProvider, PresenceIdentity } from "../../types";
import { dispatchSlackEvent } from "./dispatch";
import { slackSharedApp } from "./shared-install-service";
import { slackReach } from "./reach-card";
import {
  botScopesFor,
  buildAgentManifest,
  tombstoneAppName,
  withSyncedAppName,
  withTombstoneName,
} from "./manifest";
import {
  agentsSessionsSetStatus,
  deleteMessage,
  postBlocksMessage,
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
  usersInfo,
} from "./slack-api";
import {
  parseSlackIntegrationCredentials,
  parseSlackPresenceCredentials,
  type SlackPresenceCredentials,
} from "./types";

/**
 * Slack's entry in the channel-provider registry — everything the generic
 * services dispatch to it, and nothing Slack-shaped escaping it.
 */

/** Rotate when this close to expiry, so an in-flight create never races the
 * 12h cliff with a token about to die under it. */
const ROTATE_SLACK_SECONDS = 10 * 60;

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
 * How long to wait for a rename to reach the bot user. Slack applies a
 * manifest update to the app immediately but copies the name onto the bot
 * asynchronously — measured at ~5s. Ten one-second polls leaves headroom
 * without stalling a teardown that must stay responsive.
 */
const RENAME_POLL_ATTEMPTS = 10;
const RENAME_POLL_INTERVAL_MS = 1_000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Basic Information — where the app-level token is generated, where
 * "Install to Workspace" lives, and the only place the app's PROFILE icon
 * can be set (Slack has no API for it). */
const appSettingsUrl = (appId: string): string =>
  `https://api.slack.com/apps/${encodeURIComponent(appId)}/general`;

const log = logger.child({ component: "slack-provider" });

/**
 * The narration plan's heading. Deliberately plain: it sits above the task
 * rows for the whole turn, so it describes the ACT of working, never a
 * specific step (the rows do that).
 */
const NARRATION_PLAN_TITLE = "Working on your request";

export const slackProvider: ChannelProvider = {
  id: "slack",
  displayName: "Slack",

  // The one interpreter for both transports (dispatch.ts) — the neutral
  // dispatch hook the generic ingest door calls by registry lookup.
  dispatchInbound: dispatchSlackEvent,

  // The reach facet (reach-card.ts): the space key behind a group-thread
  // address, the guest-speaker probe, and the platform-composed owner-DM
  // card - everything provider-shaped about space grants in one home.
  reach: slackReach,

  // The deployment-owned shared app (SLACK_SHARED_* env): onboarding +
  // config-token-free agent-app minting, reached only through this facet.
  sharedApp: slackSharedApp,

  async connectIntegration(rawCredential) {
    const pasted = rawCredential.trim();
    // Config refresh tokens are the `xoxe-` family. A loose prefix check so
    // the common mistake — pasting a bot or user token — gets a real message
    // instead of Slack's opaque `invalid_refresh_token`.
    if (!pasted.startsWith("xoxe")) {
      throw new ServiceError(
        "UNPROCESSABLE",
        'That doesn\'t look like an app-configuration refresh token (it should start with "xoxe"). Copy the Refresh Token from Slack\'s "Your App Configuration Tokens" page.',
      );
    }
    // Rotation IS the validation: it proves the token works, names the
    // workspace, and replaces the (single-use) pasted pair with a fresh one.
    const rotated = await rotateConfigToken(pasted);
    return {
      tenant: { externalId: rotated.team_id, name: null },
      credentialsJson: JSON.stringify({
        accessToken: rotated.token,
        refreshToken: rotated.refresh_token,
        expiresAt: rotated.exp,
      }),
    };
  },

  async rotateIntegrationCredential(credentialsJson, options) {
    const stored = parseSlackIntegrationCredentials(credentialsJson);
    const now = Math.floor(Date.now() / 1000);
    if (!options?.force && stored.expiresAt - now > ROTATE_SLACK_SECONDS) {
      return null;
    }
    const rotated = await rotateConfigToken(stored.refreshToken);
    return {
      tenant: { externalId: rotated.team_id, name: null },
      credentialsJson: JSON.stringify({
        accessToken: rotated.token,
        refreshToken: rotated.refresh_token,
        expiresAt: rotated.exp,
      }),
    };
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
    } satisfies SlackPresenceCredentials);

    // The prefilled consent URL is the events arm's whole install flow — one
    // Allow click; our signed state rides along so the callback can prove the
    // journey started here.
    const installUrl =
      transport === "events" && oauthState
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
    const botToken = pasted.botToken?.trim() ?? "";
    const appToken = pasted.appToken?.trim() ?? "";
    const signingSecret = pasted.signingSecret?.trim() ?? "";

    if (!botToken.startsWith("xoxb-")) {
      throw new ServiceError(
        "UNPROCESSABLE",
        'The Bot User OAuth Token should start with "xoxb-". Copy it from OAuth & Permissions after installing the app.',
      );
    }
    if (transport === "socket" && !appToken.startsWith("xapp-")) {
      throw new ServiceError(
        "UNPROCESSABLE",
        'The app-level token should start with "xapp-". Generate it under Basic Information → App-Level Tokens with the connections:write scope.',
      );
    }

    const existing = existingCredentialsJson
      ? parseSlackPresenceCredentials(existingCredentialsJson)
      : {};
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
      credentialsJson: mergedJson(existing, {
        botToken: exchanged.access_token,
      }),
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
    // Installation-scoped: runs on the app's OWN credentials and needs no org
    // config token, which is why it lives outside that wrapper. Skipped on the
    // paste floor, where we never saw the user's client secret.
    //
    // The parse is inside the try because it THROWS on a malformed row, and an
    // unreadable credential must degrade to "cannot uninstall", never to a
    // failed deletion.
    try {
      const creds = credentialsJson
        ? parseSlackPresenceCredentials(credentialsJson)
        : null;
      if (!creds?.botToken || !creds.clientId || !creds.clientSecret) return;
      await appsUninstall({
        botToken: creds.botToken,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
      });
    } catch {
      // An already-uninstalled app answers `account_inactive`, which is the
      // desired end state, not a failure. Everything else is best-effort.
    }
  },

  async renameRemotePresence({
    accessToken,
    externalId,
    credentialsJson,
    identityRef,
  }) {
    // Before the uninstall: an uninstalled app answers `app_not_found` here.
    const { manifest } = await manifestExport(accessToken, externalId);
    await manifestUpdate(
      accessToken,
      externalId,
      withTombstoneName(manifest, externalId),
    );

    // `ok` means ACCEPTED, not applied — Slack copies the name onto the bot
    // user asynchronously (~5s, against a teardown that otherwise takes ~1.5s),
    // so poll until it lands and let the caller gate the delete on the answer.
    // Parsed defensively: an unreadable row past this point means we cannot
    // CONFIRM the rename, not that it failed — the caller's warning would
    // otherwise claim the app kept its old name when it did not.
    let botToken: string | undefined;
    try {
      botToken = credentialsJson
        ? parseSlackPresenceCredentials(credentialsJson).botToken
        : undefined;
    } catch {
      return false;
    }
    if (!botToken || !identityRef) return false;

    const want = tombstoneAppName(externalId);
    for (let attempt = 0; attempt < RENAME_POLL_ATTEMPTS; attempt++) {
      await delay(RENAME_POLL_INTERVAL_MS);
      const seen = await usersInfo(botToken, identityRef)
        .then((r) => r.user.profile?.real_name)
        .catch(() => undefined);
      if (seen === want) return true;
    }
    return false;
  },

  async deleteRemotePresence({ accessToken, externalId }) {
    await manifestDelete(accessToken, externalId);
  },

  presenceSettingsUrl({ externalId }) {
    return appSettingsUrl(externalId);
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
      // so the rate is measurable in CloudWatch.
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
    if (transport !== "events" || !credentialsJson || !oauthState) {
      return { installUrl: null, settingsUrl };
    }
    let clientId: string | undefined;
    try {
      clientId = parseSlackPresenceCredentials(credentialsJson).clientId;
    } catch {
      return { installUrl: null, settingsUrl };
    }
    if (!clientId) return { installUrl: null, settingsUrl };
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
