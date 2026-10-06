import { getApp } from "@onecli/api/apps/registry";
import type { AppDefinition } from "@onecli/api/apps/types";

/**
 * Recognition of the gateway's "connect this app" links in agent output —
 * pure decisions (the lib/chat rule), shared by the transcript markdown
 * renderer (which suppresses them in the chat) and the ConnectorSuggestions
 * card (which renders them as the call to action).
 *
 * THREE gateway refusals mint dashboard links the card can absorb:
 * - `app_not_connected` → `…/connections?connect=<provider>&source=agent…`
 *   (nothing connected: the card's Connect button opens the OAuth popup)
 * - `access_restricted` → `…/connections/apps/<provider>` (an account exists
 *   but THIS agent has no grant: the card's Manage button opens the
 *   permissions dialog, which is exactly the attach surface)
 * - `connection_needs_reconnect` → `…/connections/apps/<provider>?reconnect=<id>`
 *   (the provider rejected that account's saved login: the card's Reconnect
 *   button re-authorizes exactly that account in the OAuth popup)
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
   * "reconnect" re-authorizes `connectionId` in the OAuth popup. */
  kind: "connect" | "attach" | "reconnect";
  /** The account to re-authorize (`reconnect` only). */
  connectionId?: string;
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
 * by more than one shape keeps the first occurrence. */
export const extractConnectSuggestions = (text: string): CardSuggestion[] => {
  const seen = new Set<string>();
  const out: CardSuggestion[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s)\]>"']+/g)) {
    const parsed = parseConnectLink(
      match[0].replace(TRAILING_PUNCTUATION_RE, ""),
    );
    if (!parsed || seen.has(parsed.provider)) continue;
    seen.add(parsed.provider);
    const { provider, ...rest } = parsed;
    const app = getApp(provider);
    if (app) out.push({ app, ...rest });
  }
  return out;
};
