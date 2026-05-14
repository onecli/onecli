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
  },
  available: true,
};
