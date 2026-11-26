import type { AppDefinition } from "./types";

// Onyx Cloud (cloud.onyx.app) with an API key or Personal Access Token, both
// sent as a standard Bearer (docs.onyx.app, Overview & Auth). Onyx's hosted
// MCP server at cloud.onyx.app/mcp accepts the same token. Onyx has no
// third-party OAuth, so the token is the only connection method.
//
// cloud.onyx.app also serves the Onyx web app, so the gateway injects only
// under the API (`/api/`) and the MCP server (`/mcp`), never on page loads.
// Self-hosted Onyx answers on the customer's own domain and is not covered.

const ONYX_API_BASE = "https://cloud.onyx.app/api";

/** `GET /me`: the user (or service account) behind the token, as read here. */
interface OnyxMeResponse {
  email?: string;
  team_name?: string | null;
}

export const onyx: AppDefinition = {
  id: "onyx",
  setupGuideUrl: "https://onecli.sh/docs/integrations/onyx",
  name: "Onyx",
  apiDocsUrl: "https://docs.onyx.app/developers/overview",
  apiSpecUrl: "https://cloud.onyx.app/api/openapi.json",
  // Onyx's mark (web/public/logo.svg in the Onyx repo) is single-color
  // black, so a white twin covers dark mode.
  icon: "/icons/onyx.svg",
  darkIcon: "/icons/onyx-light.svg",
  description:
    "Enterprise AI search and chat. Search connected company knowledge, chat with agents, and manage documents.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiKey",
        label: "API key or access token",
        description:
          "An admin API key (Admin Panel → Service Accounts) or a Personal Access Token (Settings → Accounts & Access). Agents get exactly the access the key has.",
        placeholder: "<your Onyx API key or token>",
        secret: true,
        helpUrl: "https://docs.onyx.app/developers/overview#authentication",
        helpLabel: "How to create a key",
      },
    ],
    resolveMetadata: async (fields) => {
      const apiKey = fields.apiKey?.trim() ?? "";
      const rejected = new Error(
        "Onyx rejected this key. Double-check it, and that it belongs to Onyx Cloud (cloud.onyx.app).",
      );
      // GET /me is the "who am I": an email for a PAT, the service account
      // for an API key. Bounded: the connect request awaits it.
      const res = await fetch(`${ONYX_API_BASE}/me`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);

      if (res?.status === 401 || res?.status === 403) throw rejected;

      // Onyx Cloud answers a bare 500 (not 401) for a token it cannot even
      // decode, which is what a mistyped or foreign key is. Tell that apart
      // from a real outage with the public health check: if Onyx is healthy,
      // the 500 was about the key. If the health check fails too, accept the
      // key rather than block a connect on Onyx's downtime.
      if (res?.status === 500) {
        const health = await fetch(`${ONYX_API_BASE}/health`, {
          signal: AbortSignal.timeout(5000),
        }).catch(() => null);
        if (health?.ok) throw rejected;
        return null;
      }
      if (!res?.ok) return null;

      const me = (await res.json().catch(() => null)) as OnyxMeResponse | null;
      const email = me?.email;
      if (!email) return null;
      return {
        name: me.team_name ? `${email} (${me.team_name})` : email,
        email,
        username: email,
      };
    },
  },
  labelHint: 'e.g. "search-bot", "personal"',
};
