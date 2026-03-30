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
  },
  available: true,
};
