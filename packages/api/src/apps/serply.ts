import type { AppDefinition } from "./types";

export const serply: AppDefinition = {
  id: "serply",
  name: "Serply",
  icon: "/icons/serply.svg",
  description: "Google web, news, scholar, and video search results.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiKey",
        label: "API Key",
        description:
          "Your Serply API key. Find it in your dashboard at serply.io",
        placeholder: "Enter API Key",
      },
    ],
  },
  labelHint: 'e.g. "research", "monitoring"',
};
