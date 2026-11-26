import type { AppDefinition } from "./types";

// Dripify (dripify.com) Open API: one API key per account, sent as an
// `X-Api-Key` header (api.dripify.com, ApiKeyAuth). The hosted MCP server
// (app.dripify.com/api/v1/mcp) takes the same key the same way. There is no
// OAuth on either, so the API key is the only connection method. The API is
// only on Dripify's Advanced and Pro plans. Requests are capped at 60 a minute
// and 5,000 a day per key.
export const dripify: AppDefinition = {
  id: "dripify",
  setupGuideUrl: "https://onecli.sh/docs/integrations/dripify",
  name: "Dripify",
  apiDocsUrl: "https://api.dripify.com/",
  // Dripify's own mark (the vector version of its favicon) in the brand
  // purple, which reads on light and dark backgrounds, so no darkIcon.
  icon: "/icons/dripify.svg",
  description:
    "LinkedIn outreach automation. Campaigns, leads, conversations, and team stats.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiKey",
        label: "API key",
        description:
          "In Dripify, go to Settings → Integrations → API Key and select Generate. Needs the Advanced or Pro plan.",
        placeholder: "<your Dripify API key>",
        secret: true,
        helpUrl: "https://help.dripify.com/en/articles/16664719-open-api",
        helpLabel: "How to get your API key",
      },
    ],
    resolveMetadata: async (fields) => {
      const apiKey = fields.apiKey?.trim() ?? "";
      // GET /teams is the cheapest authenticated read. Bounded, because the
      // connect request awaits it.
      const res = await fetch(
        "https://api.dripify.com/v1/open-api/teams?limit=1",
        {
          headers: { "X-Api-Key": apiKey },
          signal: AbortSignal.timeout(5000),
        },
      ).catch(() => null);
      // 401: a bad or revoked key, answered before the rate limiter runs.
      if (res?.status === 401) {
        throw new Error(
          "Dripify rejected this API key. Double-check it, or generate a new one if it was revoked.",
        );
      }
      // 403: the key is valid but the account's plan has no Open API, so
      // every call an agent makes would fail the same way.
      if (res?.status === 403) {
        throw new Error(
          "This Dripify plan doesn't include the Open API. It is available on the Advanced and Pro plans.",
        );
      }
      // Anything else connects: a valid key, a rate limit, an outage, or a
      // 404 (Dripify gives "Open API switched off" only as its most common
      // cause, so it is no proof the key is unusable). The API has no account
      // identity, so the connection takes the user's label (or "API Key").
      return null;
    },
  },
  labelHint: 'e.g. "sales-team", "personal"',
};
