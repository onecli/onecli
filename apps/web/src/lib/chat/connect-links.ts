import { getApp } from "@onecli/api/apps/registry";
import type { AppDefinition } from "@onecli/api/apps/types";
import {
  GITHUB_OAUTH_PROVIDER,
  isGitHubOrgLogin,
} from "@onecli/api/lib/github-org-access";

/**
 * Recognition of the gateway's "connect this app" links in agent output —
 * pure decisions (the lib/chat rule), shared by the transcript markdown
 * renderer (which suppresses them in the chat) and the ConnectorSuggestions
 * card (which renders them as the call to action).
 *
 * FOUR gateway refusals mint dashboard links the card can absorb:
 * - `app_not_connected` → `…/connections?connect=<provider>&source=agent…`
 *   (nothing connected: the card's Connect button opens the OAuth popup)
 * - `access_restricted` → `…/agents/<id>/connections?attach=<provider>`, or
 *   `…/connections/apps/<provider>` when the gateway knows no agent (an
 *   account exists but THIS agent is not switched on for it: the card's
 *   Attach button opens the attach dialog). Its `connect_url` alternative
 *   names the same app, so the attach row wins over the connect row.
 * - `connection_needs_reconnect` → `…/connections/apps/<provider>?reconnect=<id>`
 *   (the provider rejected that account's saved login: the card's Reconnect
 *   button re-authorizes exactly that account in the OAuth popup)
 * - `github_org_access_required` → `…/connections/apps/github?org_access=<org>`
 *   (one GitHub organization refused the account: the card names the
 *   organization and links to the account page, where its fix steps live)
 *
 * Only an app connection the registry can name gets the app-page link. Every
 * other restricted credential (a custom secret, an LLM key, an app connection
 * on an unregistered path) links the agent page that attaches it
 * (`…/agents/<id>/connections?tab=custom`, `…/models`, `…/connections`).
 * Those are deliberately not card links: there is no app to card, so they
 * stay in the prose as plain links.
 */

export interface ConnectSuggestion {
  provider: string;
  agentName?: string;
  /** Why the gateway minted the link — decides the card's action verb:
   * "connect" opens the OAuth popup, "attach" opens the Manage dialog,
   * "reconnect" re-authorizes `connectionId` in the OAuth popup,
   * "org_access" sends the user to the fix steps for `org`. */
  kind: "connect" | "attach" | "reconnect" | "org_access";
  /** The account to re-authorize (`reconnect` only). */
  connectionId?: string;
  /** The GitHub organization that refused the account (`org_access` only). */
  org?: string;
}

/** Connection ids are uuids today; bounded and charset-limited so a crafted
 * link can only ever name an id, which the card then looks up in the user's
 * own connections list. */
const CONNECTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const PROVIDER_ID_RE = /^[a-z0-9-]{1,64}$/;

/** A connect link as the GATEWAY mints it (the shapes above). Origin
 * deliberately unchecked — self-host and cloud bake different dashboard
 * URLs, and the provider id is validated against the app catalog before
 * anything renders. */
export const parseConnectLink = (href: string): ConnectSuggestion | null => {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  // access_restricted, agent-scoped: /agents/<id>/connections?attach=<provider>
  if (/\/agents\/[^/]+\/connections$/.test(url.pathname)) {
    const provider = url.searchParams.get("attach");
    if (!provider || !PROVIDER_ID_RE.test(provider)) return null;
    return { provider, kind: "attach" };
  }

  // app_not_connected: /connections?connect=<provider>
  if (url.pathname.endsWith("/connections")) {
    const provider = url.searchParams.get("connect");
    if (!provider || !PROVIDER_ID_RE.test(provider)) return null;
    const agentName =
      url.searchParams.get("source") === "agent"
        ? (url.searchParams.get("agent_name") ?? undefined)
        : undefined;
    return { provider, agentName, kind: "connect" };
  }

  // access_restricted: /connections/apps/<provider>
  const attachMatch = /\/connections\/apps\/([a-z0-9-]{1,64})$/.exec(
    url.pathname,
  );
  if (attachMatch?.[1]) {
    // connection_needs_reconnect: the same page, naming the dead account.
    const reconnect = url.searchParams.get("reconnect");
    if (reconnect && CONNECTION_ID_RE.test(reconnect)) {
      return {
        provider: attachMatch[1],
        kind: "reconnect",
        connectionId: reconnect,
      };
    }
    // github_org_access_required: the GitHub app page, naming the
    // organization. Only the GitHub OAuth app mints it.
    const org = url.searchParams.get("org_access");
    if (
      attachMatch[1] === GITHUB_OAUTH_PROVIDER &&
      org &&
      isGitHubOrgLogin(org)
    ) {
      return { provider: attachMatch[1], kind: "org_access", org };
    }
    return { provider: attachMatch[1], kind: "attach" };
  }

  return null;
};

/** True only for links the connect card will actually render — the prose
 * suppression predicate, and it MUST stay exactly the card's predicate
 * (shape AND catalog membership): a suppressed link with no card would
 * silently delete the user's only call to action (e.g. a provider a newer
 * gateway knows but this dashboard build doesn't). */
export const isCardConnectLink = (href: string): boolean => {
  const parsed = parseConnectLink(href);
  return parsed !== null && getApp(parsed.provider) !== undefined;
};

/** GFM autolinks shed trailing punctuation ("…connect=gmail." links as
 * …connect=gmail), so the raw-text scan must shed it identically — otherwise
 * the prose side suppresses a link the card side fails to parse, and the
 * call to action vanishes. */
const TRAILING_PUNCTUATION_RE = /[.,;:!?*_~`…]+$/;

/** A connect link resolved against the catalog: one row of the card. */
export type CardSuggestion = Omit<ConnectSuggestion, "provider"> & {
  app: AppDefinition;
};

/** Every connect link in one turn's text, deduped by provider and resolved
 * against the catalog — an unknown provider renders nothing (its link stays
 * in the prose as the fallback, see `isCardConnectLink`). A provider named
 * by more than one shape keeps its first occurrence, except that an attach
 * link replaces a connect link: `access_restricted` offers both for one app,
 * and switching the existing account on is the fix it leads with. */
export const extractConnectSuggestions = (text: string): CardSuggestion[] => {
  const byProvider = new Map<string, CardSuggestion>();
  for (const match of text.matchAll(/https?:\/\/[^\s)\]>"']+/g)) {
    const parsed = parseConnectLink(
      match[0].replace(TRAILING_PUNCTUATION_RE, ""),
    );
    if (!parsed) continue;
    const { provider, ...rest } = parsed;
    const seen = byProvider.get(provider);
    if (seen && !(seen.kind === "connect" && rest.kind === "attach")) continue;
    const app = getApp(provider);
    if (app) byProvider.set(provider, { app, ...rest });
  }
  return [...byProvider.values()];
};
