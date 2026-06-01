import type { AppDefinition } from "./types";

export const cloudflare: AppDefinition = {
  id: "cloudflare",
  name: "Cloudflare",
  icon: "/icons/cloudflare.svg",
  darkIcon: "/icons/cloudflare-light.svg",
  description:
    "Deploy Workers, manage DNS, KV, D1, Pages, and other Cloudflare services.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiToken",
        label: "API Token",
        description:
          "Your Cloudflare API token. Create one at dash.cloudflare.com/profile/api-tokens",
        placeholder: "cfut_...",
      },
    ],
    resolveMetadata: async (fields) => {
      try {
        const res = await fetch("https://api.cloudflare.com/client/v4/user", {
          headers: { Authorization: `Bearer ${fields.apiToken}` },
        });
        if (res.ok) {
          const { result } = (await res.json()) as {
            result?: {
              email?: string;
              first_name?: string;
              last_name?: string;
            };
          };
          if (result?.email) {
            const name = [result.first_name, result.last_name]
              .filter(Boolean)
              .join(" ");
            return {
              email: result.email,
              username: result.email,
              name: name || result.email,
            };
          }
        }
      } catch {
        // Non-fatal
      }
      return null;
    },
  },
  labelHint: 'e.g. "main-zone", "staging"',
  available: true,
};
