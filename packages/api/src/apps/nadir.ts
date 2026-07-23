import type { AppDefinition } from "./types";

export const nadir: AppDefinition = {
  id: "nadir",
  name: "Nadir",
  icon: "/icons/nadir.svg",
  darkIcon: "/icons/nadir-light.svg",
  description: "Right-size the model on every LLM call to cut inference cost.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiKey",
        label: "API Key",
        description:
          "Your Nadir API key. Optional: model routing also works anonymously, but a key raises the rate limit and records per-request savings.",
        placeholder: "sk-...",
        optional: true,
        helpUrl: "https://getnadir.com/dashboard/api-keys",
        helpLabel: "Create a Nadir API key",
      },
    ],
    resolveMetadata: async (fields) => {
      if (!fields.apiKey) return null;
      try {
        const res = await fetch("https://api.getnadir.com/v1/profile", {
          headers: { "X-API-Key": fields.apiKey },
        });
        if (res.ok) {
          const profile = (await res.json()) as {
            name?: string;
            email?: string;
          };
          if (profile.email) {
            return {
              name: profile.name ?? profile.email,
              username: profile.email,
            };
          }
        }
      } catch {
        // Non-fatal
      }
      return null;
    },
  },
  labelHint: 'e.g. "prod", "batch-jobs"',
  available: true,
};
