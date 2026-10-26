import type { ChannelAppMode, ChannelTransport } from "../../types";

/**
 * The generated Slack app manifest for one agent's presence — the single
 * definition both attach arms share: the guided arm posts it to
 * `apps.manifest.create`, the paste floor hands it to the user to recreate by
 * hand. Transport-aware: `socket` enables Socket Mode; `events` bakes our
 * inbound request URLs and the OAuth redirect.
 *
 * Always agent-flavored: every NEW app declares `features.agent_view` (the
 * native Slack agent UX — the sessions "Working…" loader in threads) plus the
 * `assistant:write` scope it requires. Declaring `agent_view` is ONE-WAY per
 * app (Slack refuses to revert it) and parts of the runtime are plan-gated on
 * Slack's side (`feature_disabled` on free workspaces) — the receipt layer
 * falls back to the emoji reaction there. Pre-existing apps built as plain
 * bots keep working: their presence rows stamp `appMode: "regular"` and the
 * runtime honors the stamp — only creation is agent-only.
 */

/** Slack caps: app name 35 chars, bot display name 80, description 140
 * (the manifest reference's documented cap — not 175). */
const APP_NAME_MAX = 35;
const DESCRIPTION_MAX = 140;

/**
 * What a deleted app's bot is called forever after.
 *
 * A bot user is a permanent workspace record: deleting the app deactivates it
 * but never removes it, and it keeps the name it had — so a removed "donna"
 * would answer every search for the live person. Renaming just before deletion
 * is the only moment we can change that.
 *
 * The app id rather than the old name: unmistakably not a person, and still
 * traceable in Slack's app settings.
 */
export const tombstoneAppName = (appId: string): string =>
  clamp(`deleted-app-${appId}`, APP_NAME_MAX);

/**
 * The same manifest with both name fields replaced — the shared core of the
 * tombstone rename AND the live "agent was renamed" sync. Edits an EXPORTED
 * manifest rather than building a fresh one: the app may predate the current
 * shape, and rebuilding it could rewrite scopes or URLs on the way.
 */
export const withAppName = (
  manifest: Record<string, unknown>,
  rawName: string,
): Record<string, unknown> => {
  const name = clamp(rawName.trim() || "OneCLI agent", APP_NAME_MAX);
  const features = (manifest.features ?? {}) as Record<string, unknown>;
  const botUser = (features.bot_user ?? {}) as Record<string, unknown>;
  return {
    ...manifest,
    display_information: {
      ...((manifest.display_information ?? {}) as Record<string, unknown>),
      name,
    },
    features: { ...features, bot_user: { ...botUser, display_name: name } },
  };
};

/**
 * The same manifest with both name fields replaced. Edits an EXPORTED manifest
 * rather than building a fresh one: an app being deleted may predate the
 * current shape, and rebuilding it could rewrite scopes or URLs on the way out.
 */
export const withTombstoneName = (
  manifest: Record<string, unknown>,
  appId: string,
): Record<string, unknown> => withAppName(manifest, tombstoneAppName(appId));

/** The generated About text — `buildAgentManifest` bakes the agent's name
 * into it, so the live rename must know its exact shape to move it. */
export const agentAppDescription = (clampedName: string): string =>
  clamp(`${clampedName}, a OneCLI hosted agent`, DESCRIPTION_MAX);

/**
 * The About text WITH provenance: who in the org this app answers to. Slack
 * shows the description on the app's profile card, so the owner's name and
 * email give teammates a human to ask about the bot. Clamped inside Slack's
 * 140-char budget with the owner part sacrificed first — the identity line
 * must survive whole.
 */
export const agentAppDescriptionWithOwner = (
  clampedName: string,
  owner: { name: string | null; email: string } | null,
): string => {
  const base = agentAppDescription(clampedName);
  if (!owner) return base;
  const who = owner.name?.trim()
    ? `${owner.name.trim()} (${owner.email})`
    : owner.email;
  const withOwner = `${base}. Managed by ${who}.`;
  return withOwner.length <= DESCRIPTION_MAX ? withOwner : base;
};

/**
 * The live-rename edit: both name fields replaced AND the About description
 * refreshed — but only when the exported description is exactly the one we
 * generated for the OLD name. A description someone customized in Slack's
 * dashboard is preserved (the same law `withAppName` pins for the tombstone
 * path, which never touches descriptions at all).
 */
export const withSyncedAppName = (
  manifest: Record<string, unknown>,
  rawName: string,
): Record<string, unknown> => {
  const renamed = withAppName(manifest, rawName);
  const oldInfo = (manifest.display_information ?? {}) as Record<
    string,
    unknown
  >;
  const oldName = typeof oldInfo.name === "string" ? oldInfo.name : null;
  if (oldName === null || typeof oldInfo.description !== "string") {
    return renamed;
  }
  // Ours comes in two generated shapes: the bare identity line, or the
  // identity line plus a ". Managed by …" owner suffix. Either moves with
  // the rename (the owner suffix carried over verbatim); anything else is a
  // human's custom text and is preserved untouched.
  const bare = agentAppDescription(oldName);
  const isBare = oldInfo.description === bare;
  const ownerSuffix =
    !isBare && oldInfo.description.startsWith(`${bare}. Managed by `)
      ? oldInfo.description.slice(bare.length)
      : null;
  if (!isBare && ownerSuffix === null) return renamed;
  const newInfo = (renamed.display_information ?? {}) as Record<
    string,
    unknown
  >;
  const newBare = agentAppDescription(newInfo.name as string);
  const withSuffix = ownerSuffix ? `${newBare}${ownerSuffix}` : newBare;
  return {
    ...renamed,
    display_information: {
      ...newInfo,
      description: withSuffix.length <= DESCRIPTION_MAX ? withSuffix : newBare,
    },
  };
};

const clamp = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/** Everything the agent listens for. One list — both transports subscribe
 * identically; only the delivery path differs. An app created before an
 * entry here was added learns of it through `withAgentBotEvents` (the
 * maintenance sync), never by being re-created. */
export const BOT_EVENTS = [
  "message.im",
  "app_mention",
  "message.channels",
  "message.groups",
  "member_joined_channel",
  // The invite's mirror: the bot's own removal drives the reach/thread-link
  // cleanup (the leave door). Same scope gating as member_joined_channel.
  "member_left_channel",
  // The forms Slack actually delivers to the REMOVED bot itself (public /
  // private channel). A bot kicked from a private channel was seen in prod
  // to get no member_left_channel at all; these feed the same leave door.
  // Scope-gated on channels:read / groups:read, both already held.
  "channel_left",
  "group_left",
  // The APP's own removal (the removed door): the workspace uninstalled it,
  // or revoked its bot token. No scopes needed for either.
  "app_uninstalled",
  "tokens_revoked",
  // The native Stop (the stop door). Slack shows its stop button beside the
  // agent session's "Working…" loader ONLY while the app subscribes to this;
  // without it the loader is a dead indicator. Needs `chat:write`, which
  // every app already holds, so no reinstall.
  "agent_session_stopped",
] as const;

/** A JSON object read out of an exported manifest, or an empty one when the
 * field is missing or the wrong shape (the export is Slack's, not ours). */
const objectAt = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};

/**
 * The same manifest, subscribed to every event in `BOT_EVENTS`: what an app
 * created before an event was added needs to receive it. Edits an EXPORTED
 * manifest (the rename's law: rebuilding could rewrite scopes or URLs on an
 * app that predates the current template), and only ever ADDS: an event
 * someone subscribed by hand stays subscribed. Null when nothing is missing,
 * so the caller can skip the write.
 */
export const withAgentBotEvents = (
  manifest: Record<string, unknown>,
): Record<string, unknown> | null => {
  const settings = objectAt(manifest.settings);
  const subscriptions = objectAt(settings.event_subscriptions);
  const current = Array.isArray(subscriptions.bot_events)
    ? subscriptions.bot_events.filter(
        (event): event is string => typeof event === "string",
      )
    : [];
  const missing = BOT_EVENTS.filter((event) => !current.includes(event));
  if (missing.length === 0) return null;
  return {
    ...manifest,
    settings: {
      ...settings,
      event_subscriptions: {
        ...subscriptions,
        bot_events: [...current, ...missing],
      },
    },
  };
};

/**
 * Verified against the scopes reference 2026-08-07 — exact strings matter:
 * `app_mentions:read` uses a COLON (the docs-site URL slug uses a dot, which
 * is the trap); `users:read.email` is the one genuine dot. `channels:read` +
 * `groups:read` exist because `member_joined_channel` delivery is scope-gated
 * on them — without them the event silently never fires and the whole invite
 * door is dead (no manifest-validation error warns about it).
 */
export const BOT_SCOPES = [
  "chat:write",
  // Per-message icon/username overrides (`icon_url` — the agent's avatar on
  // its Slack answers). Pre-existing installs must REINSTALL to gain it; the
  // adapter degrades gracefully (posts without the icon) until they do.
  "chat:write.customize",
  "im:history",
  "im:write",
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  // The receipt reaction (the "seen" mark on an accepted message).
  // Pre-existing installs must REINSTALL to gain it — permissions changed.
  "reactions:write",
  // Downloading user-attached files (`url_private` needs a Bearer with this
  // scope; without it Slack serves a login page, not a 401). Same reinstall
  // rule as reactions:write for pre-existing installs.
  "files:read",
  // Sending the agent's files back into the thread (send_file →
  // files.getUploadURLExternal / completeUploadExternal). Same reinstall
  // rule; a pre-existing install degrades to a link line, never a lost file.
  "files:write",
  "users:read",
  "users:read.email",
] as const;

/**
 * The scope list for one app flavor — the ONE place the manifest and a
 * resumed attach's consent URL agree on what the app asks for. NEW apps are
 * always agent-flavored (`assistant:write`: Slack requires it to declare
 * `agent_view`); the `regular` arm exists for PRE-EXISTING apps only — a
 * pending regular attach resumed after the agent-only switch must grant
 * exactly the scopes its remote manifest declared.
 */
export const botScopesFor = (appMode: ChannelAppMode): string[] =>
  appMode === "agent" ? [...BOT_SCOPES, "assistant:write"] : [...BOT_SCOPES];

/**
 * The READ-ONLY user scopes a person grants when they connect their own
 * Slack to an agent ("Connect your Slack"): list and read the channels,
 * private channels, DMs and group DMs THEY are in. Deliberately no write,
 * no search (`search:read` cannot be scoped to chosen conversations), no
 * files. The platform's read tool is the only consumer; the token never
 * leaves the server.
 */
export const USER_READ_SCOPES = [
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:read",
  "im:history",
  "mpim:read",
  "mpim:history",
  "users:read",
] as const;

/**
 * Add the user read scopes (and, when missing, the OAuth redirect) to an
 * EXPORTED manifest - export-then-edit, like the rename, so an app that
 * predates the current template keeps everything else it has. Idempotent:
 * returns null when nothing would change (no manifest update needed).
 */
export const withUserReadScopes = (
  manifest: Record<string, unknown>,
  redirectUrl: string,
): Record<string, unknown> | null => {
  const oauth = objectAt(manifest.oauth_config);
  const scopes = objectAt(oauth.scopes);
  const user = Array.isArray(scopes.user)
    ? scopes.user.filter((s): s is string => typeof s === "string")
    : [];
  const redirects = Array.isArray(oauth.redirect_urls)
    ? oauth.redirect_urls.filter((u): u is string => typeof u === "string")
    : [];
  const missingScopes = USER_READ_SCOPES.filter((s) => !user.includes(s));
  const missingRedirect = !redirects.includes(redirectUrl);
  if (missingScopes.length === 0 && !missingRedirect) return null;
  return {
    ...manifest,
    oauth_config: {
      ...oauth,
      redirect_urls: missingRedirect ? [...redirects, redirectUrl] : redirects,
      scopes: { ...scopes, user: [...user, ...missingScopes] },
    },
  };
};

/** Slack caps `agent_description` at 300 chars — its own budget, distinct
 * from the 140-char About description. */
const AGENT_DESCRIPTION_MAX = 300;

export interface AgentManifestInput {
  agentName: string;
  transport: ChannelTransport;
  /** The deployment's public HTTPS API origin, or null without one. Events
   * requires it (Slack calls back there); any app with it gets the OAuth
   * redirect, so a socket app can install by consent too. */
  publicApiUrl: string | null;
  /** The attaching member — surfaces in the app's About description so
   * teammates know whose agent this is. Optional: rebuild paths (tombstone,
   * rename) don't know the owner and keep whatever description exists. */
  owner?: { name: string | null; email: string } | null;
}

export const buildAgentManifest = ({
  agentName,
  transport,
  publicApiUrl,
  owner,
}: AgentManifestInput): Record<string, unknown> => {
  const name = clamp(agentName.trim() || "OneCLI agent", APP_NAME_MAX);
  const events = transport === "events";
  if (events && !publicApiUrl) {
    // A programming error, not a user input: the posture helper decides
    // events-capability from the same URL this bakes in.
    throw new Error("events transport requires a public API URL");
  }
  const inbound = (path: string) =>
    `${publicApiUrl?.replace(/\/$/, "")}/v1/channels/slack/${path}`;

  return {
    display_information: {
      name,
      description: owner
        ? agentAppDescriptionWithOwner(name, owner)
        : agentAppDescription(name),
    },
    features: {
      // Without an enabled, WRITABLE messages tab Slack disables the DM
      // composer entirely ("Sending messages to this app has been turned
      // off") — the scopes and `message.im` subscription alone don't open
      // it. Caught live on the first real DM attempt.
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      // Declares the app a Slack agent (required for `agents.sessions.*`).
      // `agent_description` is required whenever the block is present. No
      // `suggested_prompts` — the DM should feel like a person, not a
      // product tour.
      agent_view: {
        agent_description: clamp(
          agentAppDescription(name),
          AGENT_DESCRIPTION_MAX,
        ),
      },
      bot_user: {
        display_name: name,
        always_online: true,
      },
    },
    oauth_config: {
      scopes: { bot: botScopesFor("agent") },
      // The OAuth redirect is a BROWSER hop, not an inbound delivery: Slack
      // sends the installing admin's browser back to us. So a socket app
      // gets it too whenever this deployment has a public HTTPS origin
      // (Slack refuses non-HTTPS redirect URLs), which is what lets the
      // socket arm install with one Allow click instead of a token paste.
      ...(publicApiUrl && { redirect_urls: [inbound("oauth/callback")] }),
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: !events,
      token_rotation_enabled: false,
      event_subscriptions: {
        ...(events && { request_url: inbound("events") }),
        bot_events: [...BOT_EVENTS],
      },
      interactivity: {
        is_enabled: true,
        ...(events && { request_url: inbound("interactivity") }),
      },
    },
  };
};
