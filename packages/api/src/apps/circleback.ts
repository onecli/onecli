import type { AppDefinition } from "./types";

// Circleback (circleback.ai) REST API: one account API key, sent as a Bearer
// token (circleback.ai/docs/api). Keys look like `cb_<secret>`. There is no
// OAuth for third-party apps on the public API, so the API key is the only
// connection method.
export const circleback: AppDefinition = {
  id: "circleback",
  name: "Circleback",
  // Circleback's own mark (circleback.ai/apple-touch-icon.png, redrawn as
  // SVG): an orange "C" and a blue dot that read on light and dark
  // backgrounds, so no darkIcon.
  icon: "/icons/circleback.svg",
  description:
    "AI meeting notes. Search meetings, read notes and transcripts, and manage action items.",
  docsUrl: "https://onecli.sh/docs/integrations/circleback",
  apiDocsUrl: "https://circleback.ai/docs/api",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiKey",
        label: "API key",
        // Keys carry a scope (read, or read and write), so the hint says which
        // to pick; the API reference itself stays reachable via apiDocsUrl.
        description:
          "Create one in Circleback under Settings → API keys. Pick a read-and-write scope if agents should also update meetings, action items, or tags.",
        placeholder: "cb_...",
        secret: true,
        // The Settings → API keys deep link Circleback itself publishes
        // (circleback.ai/docs/cli), not the API reference.
        helpUrl: "https://circleback.ai/settings?tab=api-access",
        helpLabel: "Get your API key",
      },
    ],
    resolveMetadata: async (fields) => {
      const apiKey = fields.apiKey?.trim() ?? "";
      // GET /oauth/test is the API's "who am I": it returns the account email
      // (and the key's name) and costs nothing else. Bounded, because the
      // connect request awaits it; a timeout reads as unreachable below.
      const res = await fetch("https://circleback.ai/api/oauth/test", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      if (res?.status === 401) {
        throw new Error(
          "Circleback rejected this API key. Double-check the key and try again.",
        );
      }
      if (res?.ok) {
        const me = (await res.json().catch(() => null)) as {
          email?: string;
        } | null;
        if (me?.email) return { username: me.email, email: me.email };
      }
      // Unreachable API, rate limited, or any other status: the connection
      // still succeeds and is labelled by the user's label (or "API Key").
      return null;
    },
  },
  labelHint: 'e.g. "work", "personal"',
};
