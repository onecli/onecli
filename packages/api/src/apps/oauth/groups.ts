import { getApp, getApps } from "../registry";
import {
  OAUTH_CLIENT_GROUP_IDS,
  type AppDefinition,
  type OAuthClientGroupId,
} from "../types";

/**
 * Vendor OAuth client groups.
 *
 * One vendor OAuth client (a Google Cloud OAuth client, an Atlassian 3LO app,
 * an Entra app registration) serves every app of that vendor, so its config is
 * stored once under the group key (`AppConfig.provider = "google"`) and every
 * member app resolves it. Per-app rows from before grouping are still read
 * first within a scope (legacy override), but new saves always write the
 * group row.
 */

const GROUP_NAMES: Record<OAuthClientGroupId, string> = {
  google: "Google",
  atlassian: "Atlassian",
  microsoft: "Microsoft",
};

export const isOAuthClientGroupId = (id: string): id is OAuthClientGroupId =>
  (OAUTH_CLIENT_GROUP_IDS as readonly string[]).includes(id);

export const oauthClientGroupName = (group: OAuthClientGroupId): string =>
  GROUP_NAMES[group];

/** Member app ids of a group, in registry order. */
export const groupMembers = (group: OAuthClientGroupId): string[] =>
  getApps()
    .filter((a) => a.configurable?.group === group)
    .map((a) => a.id);

/** The vendor group an app belongs to, if any. */
export const groupOf = (provider: string): OAuthClientGroupId | undefined =>
  getApp(provider)?.configurable?.group;

/**
 * The AppConfig `provider` key a config for this app is SAVED under: its group
 * when it has one, else the app id. Accepts an app id or a group id.
 */
export const configKeyFor = (providerOrGroup: string): string => {
  if (isOAuthClientGroupId(providerOrGroup)) return providerOrGroup;
  return groupOf(providerOrGroup) ?? providerOrGroup;
};

/**
 * The AppConfig `provider` keys to READ for an app, most specific first:
 * a legacy per-app row overrides the group row within the same scope.
 */
export const configKeysFor = (app: AppDefinition): string[] => {
  const group = app.configurable?.group;
  return group ? [app.id, group] : [app.id];
};

/**
 * Connection providers a config key covers: every member for a group key,
 * else the key itself (an app id).
 */
export const providersForConfigKey = (key: string): string[] =>
  isOAuthClientGroupId(key) ? groupMembers(key) : [key];

/**
 * Expand a list of AppConfig `provider` keys to app ids (group keys become
 * their members), de-duplicated.
 */
export const expandConfigKeys = (keys: string[]): string[] => [
  ...new Set(keys.flatMap(providersForConfigKey)),
];

/** The per-app OAuth callback path: platform (env) and legacy per-app clients. */
export const appCallbackPath = (provider: string): string =>
  `/v1/apps/${provider}/callback`;

/** The vendor's ONE OAuth callback path, shared by every member app. */
export const vendorCallbackPath = (group: OAuthClientGroupId): string =>
  `/v1/apps/oauth/${group}/callback`;

/**
 * The OAuth callback path for a connect flow. A vendor-shared client (the
 * credentials came from a group row, e.g. `google`) uses the vendor's ONE
 * redirect URI, so an admin registers a single URL for every app of that
 * vendor, and one Atlassian 3LO app (single callback URL) can serve both
 * Jira and Confluence. Everything else keeps the per-app path, which is what
 * platform (env) clients and legacy per-app configs already have registered.
 * The signed OAuth state carries the app, so the shared callback knows which
 * app to finish.
 */
export const redirectPathFor = (
  provider: string,
  configKey: string | undefined,
): string =>
  configKey && isOAuthClientGroupId(configKey)
    ? vendorCallbackPath(configKey)
    : appCallbackPath(provider);

/**
 * The redirect path a verified OAuth state was minted for. States minted
 * before vendor callbacks existed carry none and used the per-app path.
 */
export const signedRedirectPath = (
  state: Record<string, unknown>,
  provider: string,
): string =>
  typeof state.redirectPath === "string"
    ? state.redirectPath
    : appCallbackPath(provider);

/**
 * The scopes to request when connecting `app`. A vendor-shared Atlassian
 * client asks for every member app's scopes: Atlassian keeps ONE grant per
 * user per 3LO app, and a new consent replaces the scopes of the previous
 * one, so connecting Confluence with Confluence-only scopes would strip the
 * same user's Jira access (and vice versa). Every other client keeps the
 * app's own scopes.
 */
export const authorizeScopesFor = (
  app: AppDefinition,
  configKey: string | undefined,
): string[] => {
  if (app.connectionMethod.type !== "oauth") return [];
  const own = app.connectionMethod.defaultScopes ?? [];
  if (configKey !== "atlassian") return own;
  return [
    ...new Set(
      groupMembers("atlassian").flatMap((id) => {
        const method = getApp(id)?.connectionMethod;
        return method?.type === "oauth" ? (method.defaultScopes ?? []) : [];
      }),
    ),
  ];
};

/** Public setup guides for vendor OAuth clients. */
const VENDOR_SETUP_GUIDES: Partial<Record<OAuthClientGroupId, string>> = {
  google: "https://onecli.sh/docs/integrations/google",
};

/**
 * The vendor's setup guide for a grouped app (only vendors that have one).
 * Shown instead of the app's own `setupGuideUrl` on the credentials surfaces:
 * the shared client is set up once, for the whole vendor. `name` is what the
 * link reads ("Follow the {name} setup guide").
 */
export const vendorSetupGuideFor = (
  provider: string,
): { name: string; url: string } | null => {
  const group = groupOf(provider);
  const url = group && VENDOR_SETUP_GUIDES[group];
  return group && url ? { name: GROUP_NAMES[group], url } : null;
};

/**
 * One-click Google Cloud link that enables every Google API OneCLI's Google
 * apps call, in the project the admin picks. A Google client only works for
 * APIs enabled in its project; otherwise Google answers 403 SERVICE_DISABLED
 * even though the connection succeeded. The docs guide links the same URL.
 */
export const GOOGLE_ENABLE_APIS_URL =
  "https://console.cloud.google.com/flows/enableapi?apiid=" +
  [
    "gmail",
    "admin",
    "analyticsdata",
    "calendar-json",
    "chat",
    "classroom",
    "people",
    "docs",
    "drive",
    "forms",
    "meet",
    "photoslibrary",
    "searchconsole",
    "sheets",
    "slides",
    "tasks",
    "youtube",
  ]
    .map((api) => `${api}.googleapis.com`)
    .join(",");

/** "One Google client for all Google apps (Gmail, Drive, Calendar +14 more)". */
const vendorClientSummary = (group: OAuthClientGroupId): string => {
  const names = groupMembers(group)
    .map((id) => getApp(id)?.name)
    .filter((n): n is string => !!n);
  const more = names.length > 3 ? ` +${names.length - 3} more` : "";
  const name = GROUP_NAMES[group];
  return `One ${name} client for all ${name} apps (${names.slice(0, 3).join(", ")}${more})`;
};

/**
 * Where a credentials save lands, for the form and the setup dialog: an
 * org-level save applies to every workspace, a workspace save overrides the
 * org for that workspace, and a vendor client covers every app of its vendor.
 */
export const credentialsScopeNote = (
  provider: string,
  pageScope: "workspace" | "organization",
): string => {
  const where =
    pageScope === "organization"
      ? "every workspace in your organization"
      : "this workspace (overrides your organization's client)";
  const group = groupOf(provider);
  return group
    ? `${vendorClientSummary(group)} in ${where}.`
    : `Applies to ${where}.`;
};
