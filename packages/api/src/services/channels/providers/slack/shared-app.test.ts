import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSharedAppManifest,
  sharedAppInstallUrl,
  sharedSlackApp,
  SHARED_BOT_SCOPES,
  SHARED_USER_SCOPES,
} from "./shared-app";

/**
 * The shared-app deployment config and its two derived artifacts: the
 * consent URL and the self-host manifest (events-only, both inbound URLs +
 * the OAuth redirect baked). The gating contract under test:
 * - the app exists on credential presence alone (`sharedSlackApp`);
 * - the app-manager USER scopes appear (URL and manifest alike) only when
 *   `SLACK_SHARED_APP_MANAGER_APPROVED` — Slack refuses them otherwise.
 */

const CREDENTIAL_KEYS = [
  "SLACK_SHARED_CLIENT_ID",
  "SLACK_SHARED_CLIENT_SECRET",
  "SLACK_SHARED_SIGNING_SECRET",
  "SLACK_SHARED_APP_ID",
] as const;
const ENV_KEYS = [
  ...CREDENTIAL_KEYS,
  "SLACK_SHARED_APP_MANAGER_APPROVED",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const setCredentials = () => {
  process.env.SLACK_SHARED_CLIENT_ID = "123.456";
  process.env.SLACK_SHARED_CLIENT_SECRET = "secret";
  process.env.SLACK_SHARED_SIGNING_SECRET = "signing";
  process.env.SLACK_SHARED_APP_ID = "A0SHARED";
};

describe("sharedSlackApp", () => {
  it("answers null unless ALL FOUR env vars are set — a half-configured app must not exist", () => {
    expect(sharedSlackApp()).toBeNull();
    for (const missing of CREDENTIAL_KEYS) {
      setCredentials();
      delete process.env[missing];
      expect(sharedSlackApp()).toBeNull();
    }
  });

  it("arms on the four credentials alone — they are the feature's whole switch", () => {
    setCredentials();
    expect(sharedSlackApp()).toEqual({
      clientId: "123.456",
      clientSecret: "secret",
      signingSecret: "signing",
      appId: "A0SHARED",
    });
  });
});

describe("sharedAppInstallUrl", () => {
  const mint = () =>
    new URL(
      sharedAppInstallUrl({
        clientId: "123.456",
        redirectUri: "https://api.example.com/v1/channels/slack/oauth/callback",
        state: "signed-state",
      }),
    );

  it("grants exactly the onboarding scopes — the shared app reads DMs and emails, nothing more", () => {
    const url = mint();
    expect(url.origin + url.pathname).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
    expect(url.searchParams.get("scope")).toBe(SHARED_BOT_SCOPES.join(","));
    expect(url.searchParams.get("client_id")).toBe("123.456");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/v1/channels/slack/oauth/callback",
    );
  });

  it("requests NO user scopes pre-approval — Slack fails the consent screen on them", () => {
    expect(mint().searchParams.get("user_scope")).toBeNull();
  });

  it("requests the app-manager user scopes once the deployment declares approval", () => {
    process.env.SLACK_SHARED_APP_MANAGER_APPROVED = "true";
    expect(mint().searchParams.get("user_scope")).toBe(
      SHARED_USER_SCOPES.join(","),
    );
  });
});

describe("buildSharedAppManifest", () => {
  const build = () =>
    buildSharedAppManifest({ publicApiUrl: "https://api.example.com" });

  it("is events-only: socket mode off, both inbound URLs + the redirect baked", () => {
    const manifest = build();
    const settings = manifest.settings as {
      socket_mode_enabled: boolean;
      event_subscriptions: { request_url: string };
      interactivity: { request_url: string };
    };
    expect(settings.socket_mode_enabled).toBe(false);
    expect(settings.event_subscriptions.request_url).toBe(
      "https://api.example.com/v1/channels/slack/events",
    );
    expect(settings.interactivity.request_url).toBe(
      "https://api.example.com/v1/channels/slack/interactivity",
    );
    const oauth = manifest.oauth_config as { redirect_urls: string[] };
    expect(oauth.redirect_urls).toEqual([
      "https://api.example.com/v1/channels/slack/oauth/callback",
    ]);
  });

  it("declares only the minimal bot scopes pre-approval — Slack rejects a manifest with unapproved user scopes", () => {
    const oauth = build().oauth_config as {
      scopes: { bot: string[]; user?: string[] };
    };
    expect(oauth.scopes.bot).toEqual([...SHARED_BOT_SCOPES]);
    expect(oauth.scopes.user).toBeUndefined();
  });

  it("declares the app-manager user scopes once the deployment declares approval", () => {
    process.env.SLACK_SHARED_APP_MANAGER_APPROVED = "true";
    const oauth = build().oauth_config as {
      scopes: { bot: string[]; user?: string[] };
    };
    expect(oauth.scopes.user).toEqual([...SHARED_USER_SCOPES]);
  });

  it("subscribes to the lifecycle events so an uninstall clears the row", () => {
    const settings = build().settings as {
      event_subscriptions: { bot_events: string[] };
    };
    expect(settings.event_subscriptions.bot_events).toContain(
      "app_uninstalled",
    );
    expect(settings.event_subscriptions.bot_events).toContain("tokens_revoked");
  });

  it("keeps the DM composer open (writable messages tab)", () => {
    const features = build().features as {
      app_home: {
        messages_tab_enabled: boolean;
        messages_tab_read_only_enabled: boolean;
      };
    };
    expect(features.app_home.messages_tab_enabled).toBe(true);
    expect(features.app_home.messages_tab_read_only_enabled).toBe(false);
  });
});
