import { db } from "@onecli/db";
import { getApps } from "../apps/registry";
import type { AppDefinition } from "../apps/types";
import { dashboardUrl } from "../lib/dashboard-url";
import { connectionsForRender } from "./agent-connections-render";

/**
 * `request_app_connection`: the agent's door to a built-in app it does not
 * hold yet, so the chat can offer the native Connect card instead of a
 * generic dashboard link.
 *
 * Why it exists: the card is lifted from a gateway-minted connect link
 * (`…/connections?connect=<provider>…`), and the gateway mints one only when
 * a request actually hits the app. An agent that checked `list_apps` first,
 * saw no Jira and stopped, never made that request, so it wrote its own
 * `…/connections` link (no card) and offered a custom API-token connection
 * for an app OneCLI connects natively. This tool mints the same links the
 * gateway would, without a doomed API call, and says which fix applies:
 *
 * - `connected`: the agent already holds the app; use it.
 * - `attach`: the workspace (or its organization) has an account, this agent
 *   is just not switched on for it: the gateway's `access_restricted` links.
 * - `connect`: nothing connected: the gateway's `app_not_connected` link,
 *   naming the agent so the new account lands switched on for it.
 * - `no_builtin_app`: only now is a custom connection the right fix.
 *
 * Fenced by the resolved identity alone: the grant read is the agent's own
 * (`connectionsForRender`), the account probe is this workspace's and this
 * organization's pool, and only existence is read, never a credential.
 */

const normalize = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Below this many characters a query is too vague to suggest anything for,
 * and an app's name counts only as a whole word of the query: "x" or "aws"
 * would otherwise turn up inside any word ("mixpanel", "laws"). */
const MIN_SIMILAR_CHARS = 4;

/** Percent-encodes every byte but an ASCII letter or digit, exactly like the
 * gateway's `connect_url` (`utf8_percent_encode(.., NON_ALPHANUMERIC)`).
 * `encodeURIComponent` alone leaves `-_.!~*'()` raw, and a raw `'` ends the
 * chat card's link scan early, cutting the agent's name short. */
const encodeNonAlphanumeric = (value: string): string =>
  encodeURIComponent(value).replace(
    /[-_.!~*'()]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** The catalog app a free-text name or id means: an exact match on the id
 * or the display name, ignoring case, spaces and punctuation ("Google
 * Calendar", "google-calendar", "googlecalendar"). Never a fuzzy guess: the
 * wrong app's connect card is worse than none. */
export const resolveCatalogApp = (query: string): AppDefinition | undefined => {
  const key = normalize(query);
  if (!key) return undefined;
  return getApps().find(
    (app) => normalize(app.id) === key || normalize(app.name) === key,
  );
};

const docsHostOf = (url: string | undefined): string => {
  if (!url) return "";
  try {
    return normalize(new URL(url).hostname);
  } catch {
    return "";
  }
};

/** Near misses for a query that named no app exactly, so the agent can
 * retry with the right one ("atlassian" → Jira, Confluence: the vendor is
 * read from the app's API docs host; "salesforce cpq" → Salesforce: the
 * query names the app). */
const similarApps = (query: string): { app: string; name: string }[] => {
  const key = normalize(query);
  if (key.length < MIN_SIMILAR_CHARS) return [];
  const queryWords = query.toLowerCase().split(/[^a-z0-9]+/);
  const queryNames = (name: string): boolean =>
    name.length >= MIN_SIMILAR_CHARS
      ? key.includes(name)
      : queryWords.includes(name);
  return getApps()
    .filter((app) => {
      const id = normalize(app.id);
      const name = normalize(app.name);
      return (
        id.includes(key) ||
        name.includes(key) ||
        queryNames(id) ||
        queryNames(name) ||
        normalize(app.description).includes(key) ||
        docsHostOf(app.apiDocsUrl).includes(key)
      );
    })
    .slice(0, 5)
    .map((app) => ({ app: app.id, name: app.name }));
};

interface AppConnectionRequester {
  agentId: string;
  workspaceId: string;
  organizationId: string;
}

type AppConnectionRequestResult =
  | { status: "connected"; app: string; name: string; note: string }
  | {
      status: "attach";
      app: string;
      name: string;
      manageUrl: string;
      connectUrl: string;
      note: string;
    }
  | {
      status: "connect";
      app: string;
      name: string;
      connectUrl: string;
      note: string;
    }
  | {
      status: "no_builtin_app";
      similar: { app: string; name: string }[];
      note: string;
    };

const LINK_RULE =
  "Show the link to the person you work with as a bare URL on its own line (no angle brackets, no markdown link). Do not offer an API key, an API token or a custom connection for a built-in app. Retry the original request once they say it is done.";

export const requestAppConnection = async (
  requester: AppConnectionRequester,
  query: string,
): Promise<AppConnectionRequestResult> => {
  const app = resolveCatalogApp(query);
  if (!app) {
    const similar = similarApps(query);
    return {
      status: "no_builtin_app",
      similar,
      note:
        similar.length > 0
          ? "No built-in OneCLI app has exactly that name. If one of `similar` is the service, call request_app_connection again with its `app` id. Only if none is, propose a custom connection."
          : "OneCLI has no built-in app for this service. A custom connection (propose_custom_connection) is the way to connect it.",
    };
  }

  const granted = await connectionsForRender(requester.agentId);
  if (granted.some((c) => c.provider === app.id)) {
    return {
      status: "connected",
      app: app.id,
      name: app.name,
      note: `${app.name} is already connected and on for you: call its API directly (list_apps shows the host and endpoints).`,
    };
  }

  const scope = { workspaceId: requester.workspaceId };
  const [agent, switchable] = await Promise.all([
    db.agent.findFirst({
      where: { id: requester.agentId, workspaceId: requester.workspaceId },
      select: { name: true },
    }),
    // Existence only, in this tenant's pool: the workspace's own accounts
    // and the organization's shared ones. Never a credential, never another
    // org. An account waiting on a reconnect is no fix to switch on, so it
    // reads as nothing connected, like the gateway's `inactive_apps`.
    db.appConnection.findFirst({
      where: {
        provider: app.id,
        status: "connected",
        reauthRequiredAt: null,
        OR: [
          { workspaceId: requester.workspaceId },
          { organizationId: requester.organizationId, scope: "organization" },
        ],
      },
      select: { id: true },
    }),
  ]);
  // The gateway's `app_not_connected` link, byte for byte: the chat card
  // parses this shape, and `agent_id` makes the new account land switched on
  // for this agent (the API fences the id to the workspace before using it).
  const agentParams = agent
    ? `&source=agent&agent_name=${encodeNonAlphanumeric(agent.name)}&agent_id=${encodeNonAlphanumeric(requester.agentId)}`
    : "";
  const connectUrl = dashboardUrl(
    `/connections?connect=${app.id}${agentParams}`,
    scope,
  );

  if (switchable) {
    return {
      status: "attach",
      app: app.id,
      name: app.name,
      manageUrl: dashboardUrl(
        `/agents/${encodeURIComponent(requester.agentId)}/connections?attach=${app.id}`,
        scope,
      ),
      connectUrl,
      note: `${app.name} is already connected in OneCLI but turned off for you. Ask the person to turn it on for you with manageUrl; offer connectUrl after it only for a different account. ${LINK_RULE}`,
    };
  }

  return {
    status: "connect",
    app: app.id,
    name: app.name,
    connectUrl,
    note: `${app.name} is a built-in OneCLI app that is not connected yet. Ask the person to connect it with connectUrl; the OneCLI chat shows it as a Connect button. ${LINK_RULE}`,
  };
};
