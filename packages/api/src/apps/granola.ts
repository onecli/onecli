import type { AppDefinition } from "./types";

export const granola: AppDefinition = {
  id: "granola",
  name: "Granola",
  icon: "/icons/granola.svg",
  description: "AI meeting notes. Search and retrieve your notes and folders.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiKey",
        label: "API Key",
        description:
          "Your Granola API key. Create one in the Granola desktop app under Settings → Connectors → API keys.",
        placeholder: "grn_...",
      },
    ],
  },
  labelHint: 'e.g. "work", "personal"',
};
