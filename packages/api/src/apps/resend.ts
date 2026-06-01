import type { AppDefinition } from "./types";

export const resend: AppDefinition = {
  id: "resend",
  name: "Resend",
  icon: "/icons/resend.svg",
  darkIcon: "/icons/resend-light.svg",
  description: "Send transactional and marketing emails.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiKey",
        label: "API Key",
        description: "Your Resend API key. Find it at resend.com/api-keys",
        placeholder: "re_...",
      },
    ],
    resolveMetadata: async (fields) => {
      try {
        const res = await fetch("https://api.resend.com/domains", {
          headers: { Authorization: `Bearer ${fields.apiKey}` },
        });
        if (res.ok) {
          const { data } = (await res.json()) as {
            data?: { name?: string; id?: string }[];
          };
          const domain = data?.[0];
          if (domain?.name) {
            return {
              name: domain.name,
              username: domain.name,
            };
          }
        }
      } catch {
        // Non-fatal
      }
      return null;
    },
  },
  labelHint: 'e.g. "transactional", "marketing"',
  available: true,
};
