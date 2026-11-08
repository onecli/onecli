import type { AppDefinition } from "./types";

// Tavily (tavily.com): web search, extract, crawl, map, and research for
// agents. One API key (`tvly-…`) is sent as `Authorization: Bearer` to the
// REST API (api.tavily.com) and to the hosted MCP server
// (mcp.tavily.com/mcp), which passes it through to the same API. The REST API
// takes nothing but API keys, so the key is the only connection method.
export const tavily: AppDefinition = {
  id: "tavily",
  name: "Tavily",
  // Base URL and Bearer auth. Every endpoint's parameters are in the OpenAPI
  // file below, which the docs site splits over one page per endpoint.
  apiDocsUrl: "https://docs.tavily.com/documentation/api-headers",
  apiSpecUrl:
    "https://docs.tavily.com/documentation/api-reference/openapi.json",
  // Tavily's mark (from its site's icon.svg) as a one-color knockout, so it
  // ships with a white-fill variant for dark mode.
  icon: "/icons/tavily.svg",
  darkIcon: "/icons/tavily-light.svg",
  description: "Web search, extraction, crawling, and research for AI agents.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiKey",
        label: "API key",
        description: "Create or copy a key on the Tavily dashboard.",
        placeholder: "tvly-...",
        secret: true,
        helpUrl: "https://app.tavily.com/home",
        helpLabel: "Get your API key",
      },
    ],
    resolveMetadata: async (fields) => {
      const apiKey = fields.apiKey?.trim() ?? "";
      // GET /usage costs no credits, unlike a search. Bounded, because the
      // connect request awaits it.
      const res = await fetch("https://api.tavily.com/usage", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      // 401: a missing, mistyped, or revoked key.
      if (res?.status === 401) {
        throw new Error(
          "Tavily rejected this API key. Double-check it, or create a new one on the Tavily dashboard.",
        );
      }
      // Anything else connects: a valid key, a rate limit (/usage allows 10
      // calls per 10 minutes), or an outage. The API returns no account
      // identity, so the connection takes the user's label (or "API Key").
      return null;
    },
  },
  labelHint: 'e.g. "personal", "work"',
};
