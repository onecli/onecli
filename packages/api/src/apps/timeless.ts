import type { AppDefinition } from "./types";

// Timeless (timeless.day) REST API: one personal API token, sent as a Bearer
// token (https://docs.timeless.day/api-reference). There is no OAuth for the
// public API, so the API key is the only connection method.
export const timeless: AppDefinition = {
  id: "timeless",
  setupGuideUrl: "https://onecli.sh/docs/integrations/timeless",
  name: "Timeless",
  apiDocsUrl: "https://docs.timeless.day/api-reference/introduction",
  // Timeless's own mark (timeless.day/icon.svg): two brand-red squares that
  // read on both light and dark backgrounds, so no darkIcon.
  icon: "/icons/timeless.svg",
  description:
    "AI meeting notes. Search meetings, read transcripts and summaries, and send the note-taker.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiKey",
        label: "API token",
        description:
          "Create one in your Timeless dashboard under API token. Tokens are 64-character hex strings.",
        placeholder: "<your Timeless API token>",
        secret: true,
        helpUrl: "https://my.timeless.day/api-token",
        helpLabel: "Get your API token",
      },
    ],
    resolveMetadata: async (fields) => {
      const apiKey = fields.apiKey?.trim() ?? "";
      // The API has no "who am I" endpoint, so the cheapest authenticated
      // call validates the token: one room, nothing else. Bounded, because
      // the connect request awaits it; a timeout reads as unreachable below.
      const res = await fetch("https://api.timeless.day/v1/rooms?limit=1", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      if (res?.status === 401) {
        throw new Error(
          "Timeless rejected this API token. Double-check the token and try again.",
        );
      }
      // Valid token, unreachable API, or any other status: the connection
      // still succeeds and is labelled by the user's label (or "API Key").
      return null;
    },
  },
  labelHint: 'e.g. "work", "personal"',
};
