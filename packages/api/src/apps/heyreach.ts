import type { AppDefinition } from "./types";

// HeyReach (heyreach.io) public API: one workspace API key, sent as an
// `X-API-KEY` header (api.heyreach.io/api/public). There is no OAuth on the
// public API, so the API key is the only connection method. Keys never
// expire, but creating a new one deactivates the old. Requests are capped at
// 300 a minute.
export const heyreach: AppDefinition = {
  id: "heyreach",
  name: "HeyReach",
  // HeyReach's own mark (a waving hand trailing coloured speed lines),
  // redrawn as SVG at icon scale. The palm is filled white inside a dark
  // outline, so it reads on light and dark backgrounds alike and needs no
  // darkIcon.
  icon: "/icons/heyreach.svg",
  description:
    "LinkedIn outreach. Campaigns, leads, the unified inbox, and sender accounts.",
  setupGuideUrl: "https://onecli.sh/docs/integrations/heyreach",
  apiDocsUrl: "https://documenter.getpostman.com/view/23808049/2sA2xb5F75",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiKey",
        label: "API key",
        // A key is per workspace, which is how HeyReach separates clients:
        // worth saying, because an agency holds one key per client.
        description:
          "In HeyReach, go to Settings → Integrations → API Integration. Each key covers one workspace.",
        placeholder: "<your HeyReach API key>",
        secret: true,
      },
    ],
    resolveMetadata: async (fields) => {
      const apiKey = fields.apiKey?.trim() ?? "";
      // GET /auth/CheckApiKey is the API's own key check: 200 for a working
      // key, 401 otherwise, with no body either way, so there is no account
      // to label the connection with. Bounded, because the connect request
      // awaits it.
      const res = await fetch(
        "https://api.heyreach.io/api/public/auth/CheckApiKey",
        {
          headers: { "X-API-KEY": apiKey },
          signal: AbortSignal.timeout(5000),
        },
      ).catch(() => null);
      if (res?.status === 401) {
        throw new Error(
          "HeyReach rejected this API key. Double-check it, or create a new one if it was replaced.",
        );
      }
      // Anything else connects: a working key, a rate limit (429), or an
      // outage. The connection takes the user's label (or "API Key").
      return null;
    },
  },
  labelHint: 'e.g. "acme-client", "personal"',
};
