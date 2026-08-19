import type { AppDefinition } from "./types";

// Serply (serply.io): Google web, news, scholar, and video results for agents.
// One API key is sent in the `X-Api-Key` header to the REST API
// (api.serply.io), which also serves the hosted MCP server at /mcp, so the
// key is the only connection method.
export const serply: AppDefinition = {
  id: "serply",
  name: "Serply",
  apiDocsUrl: "https://serply.io/docs",
  icon: "/icons/serply.svg",
  description: "Google web, news, scholar, and video search results.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiKey",
        label: "API key",
        description: "Copy your key from the Serply dashboard.",
        placeholder: "Enter API key",
        secret: true,
        helpUrl: "https://serply.io",
        helpLabel: "Get your API key",
      },
    ],
  },
  labelHint: 'e.g. "research", "monitoring"',
};
