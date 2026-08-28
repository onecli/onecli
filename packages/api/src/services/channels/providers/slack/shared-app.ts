/**
 * The shared app's OWN scope list — deliberately NOT the per-agent
 * BOT_SCOPES. The onboarding bot answers DMs and mentions with one button;
 * a marketplace review reads every scope as a data-access claim, so the
 * list is the minimum that behavior needs:
 * - chat:write        — post the reply
 * - im:history        — receive message.im events
 * - app_mentions:read — receive app_mention events
 * - users:read        — users.info (display name)
 * - users:read.email  — the Slack-verified email the invitation is minted for
 */
export const SHARED_BOT_SCOPES = [
  "chat:write",
  "im:history",
  "app_mentions:read",
  "users:read",
  "users:read.email",
] as const;

/**
 * The shared app's USER scopes — the NanoClaw trick. The installing admin's
 * user token carries the App Manifest API (`app_configurations:write`) and
 * managed installs (`managed_apps:install`), so after ONE workspace install
 * the deployment can mint and install per-agent Slack apps programmatically:
 * no config-token paste, no 12h rotation treadmill. The pasted `xoxe-`
 * config token stays as the fallback for workspaces without the shared app.
 */
export const SHARED_USER_SCOPES = [
  "app_configurations:write",
  "managed_apps:install",
] as const;

/**
 * Slack blocks unapproved apps at the API, not at consent (live-verified on
 * dev, 2026-08-26): an authorize URL requesting the app-manager USER scopes
 * is GRANTED even for an unenrolled app, but spending the granted token on
 * `apps.manifest.create` refuses with `invalid_manager_app` until Slack
 * enrolls the app as a manager. (Manifest CREATION declaring the scopes is
 * stricter — "Illegal user scopes found".) The scopes are still requested
 * only once the deployment declares its app approved: asking admins to
 * grant a permission the deployment cannot use yet would make the consent
 * screen lie. Distinct from credential presence: a testing deployment wants
 * the ARM on (wire proofs, UI) while its real Slack app is still unapproved.
 */
export const slackAppManagerApproved = (): boolean => {
  const raw = (
    process.env.SLACK_SHARED_APP_MANAGER_APPROVED ?? ""
  ).toLowerCase();
  return raw === "true" || raw === "1" || raw === "on";
};

/**
 * The deployment's SHARED Slack app — one OneCLI-distributed app every org
 * can install with a plain "Add to Slack" click, beside the per-agent
 * dedicated apps. Its jobs: team onboarding (the bot answers DMs and
 * mentions with an account button) and, once the app-manager user scopes are
 * granted, minting per-agent apps from the install's user token.
 *
 * Config arrives by env, read at call time (the repo's test-seam convention):
 * the app is created ONCE by the operator (cloud: ours; self-host: theirs,
 * from the manifest `buildSharedAppManifest` serves) and its client creds +
 * signing secret are deployment config, not per-org data. All four set =
 * the shared app EXISTS — webhooks answer, Slack-initiated installs
 * complete, the dashboard advertises "Add to Slack" (config beats edition,
 * the same posture rule as `publicApiUrl`). All four unset = the app simply
 * doesn't exist, which is the self-host default.
 *
 * Env names use SLACK_SHARED_* to keep clear of the legacy connector's
 * SLACK_CLIENT_ID/SECRET pair (apps/slack.ts), which is a different app with
 * different scopes.
 */
export interface SlackSharedAppConfig {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  /** The app's own id (`A…`) — inbound payloads are matched on it. */
  appId: string;
}

export const sharedSlackApp = (): SlackSharedAppConfig | null => {
  const clientId = process.env.SLACK_SHARED_CLIENT_ID ?? "";
  const clientSecret = process.env.SLACK_SHARED_CLIENT_SECRET ?? "";
  const signingSecret = process.env.SLACK_SHARED_SIGNING_SECRET ?? "";
  const appId = process.env.SLACK_SHARED_APP_ID ?? "";
  if (!clientId || !clientSecret || !signingSecret || !appId) return null;
  return { clientId, clientSecret, signingSecret, appId };
};

/**
 * The workspace-install consent URL — Slack's standard OAuth v2 authorize
 * page for a distributed app. `state` is the HMAC-signed install state; the
 * callback route completes the install only after verifying it.
 */
export const sharedAppInstallUrl = (input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string => {
  const params = new URLSearchParams({
    client_id: input.clientId,
    scope: SHARED_BOT_SCOPES.join(","),
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  if (slackAppManagerApproved()) {
    params.set("user_scope", SHARED_USER_SCOPES.join(","));
  }
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
};

/**
 * The manifest a SELF-HOSTED deployment creates its own shared app from —
 * the same shape as the per-agent manifest but named for the install, and
 * events-only: the shared app is an HTTP-events surface by design (it exists
 * where a public HTTPS origin exists; socket-floor deployments use the
 * per-agent arm, which already covers them).
 */
export const buildSharedAppManifest = (input: {
  publicApiUrl: string;
}): Record<string, unknown> => {
  const inbound = (path: string) =>
    `${input.publicApiUrl.replace(/\/$/, "")}/v1/channels/slack/${path}`;
  return {
    display_information: {
      name: "OneCLI",
      description: "Sign in to OneCLI from Slack and invite your teammates",
    },
    features: {
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: "OneCLI", always_online: true },
    },
    oauth_config: {
      scopes: {
        bot: [...SHARED_BOT_SCOPES],
        // Slack VALIDATES the manifest against the app's enrollment: declaring
        // the app-manager user scopes on a non-enrolled team fails creation
        // with "Illegal user scopes found" — stricter than the authorize URL,
        // which grants the scopes and refuses only at spend time
        // (invalid_manager_app; live-verified on dev, 2026-08-26).
        ...(slackAppManagerApproved() ? { user: [...SHARED_USER_SCOPES] } : {}),
      },
      redirect_urls: [inbound("oauth/callback")],
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
      event_subscriptions: {
        request_url: inbound("events"),
        bot_events: [
          "message.im",
          "app_mention",
          // First-open welcome: the Marketplace guideline expects a message
          // when a user first opens the app's Messages tab.
          "app_home_opened",
          // Lifecycle hygiene: a workspace removing the app (or revoking its
          // tokens) must clear our install row, or the org card lies forever.
          "app_uninstalled",
          "tokens_revoked",
        ],
      },
      interactivity: {
        is_enabled: true,
        request_url: inbound("interactivity"),
      },
    },
  };
};
