import { getApp } from "@onecli/api/apps/registry";
import type { AppDefinition } from "@onecli/api/apps/types";

/**
 * Recognition of the gateway's "connect this app" links in agent output —
 * pure decisions (the lib/chat rule), shared by the transcript markdown
 * renderer (which suppresses them in the chat) and the ConnectorSuggestions
 * card (which renders them as the call to action).
 *
 * TWO gateway refusals mint dashboard links the card can absorb:
 * - `app_not_connected` → `…/connections?connect=<provider>&source=agent…`
 *   (nothing connected: the card's Connect button opens the OAuth popup)
 * - `access_restricted` → `…/connections/apps/<provider>` (an account exists
 *   but THIS agent has no grant: the card's Manage button opens the
 *   permissions dialog, which is exactly the attach surface)
 */

export interface ConnectSuggestion {
  provider: string;
  agentName?: string;
  /** Why the gateway minted the link — decides the card's action verb:
   * "connect" opens the OAuth popup, "attach" opens the Manage dialog. */
  kind: "connect" | "attach";
}

const PROVIDER_ID_RE = /^[a-z0-9-]{1,64}$/;

/** A connect link as the GATEWAY mints it (both shapes above). Origin
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

/** Every connect link in one turn's text, deduped by provider and resolved
 * against the catalog — an unknown provider renders nothing (its link stays
 * in the prose as the fallback, see `isCardConnectLink`). A provider named
 * by BOTH shapes keeps the first occurrence. */
export const extractConnectSuggestions = (
  text: string,
): { app: AppDefinition; agentName?: string; kind: "connect" | "attach" }[] => {
  const seen = new Set<string>();
  const out: {
    app: AppDefinition;
    agentName?: string;
    kind: "connect" | "attach";
  }[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s)\]>"']+/g)) {
    const parsed = parseConnectLink(
      match[0].replace(TRAILING_PUNCTUATION_RE, ""),
    );
    if (!parsed || seen.has(parsed.provider)) continue;
    seen.add(parsed.provider);
    const app = getApp(parsed.provider);
    if (app) out.push({ app, agentName: parsed.agentName, kind: parsed.kind });
  }
  return out;
};
