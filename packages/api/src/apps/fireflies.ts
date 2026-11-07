import type { AppDefinition } from "./types";

export const fireflies: AppDefinition = {
  id: "fireflies",
  setupGuideUrl: "https://onecli.sh/docs/integrations/fireflies",
  name: "Fireflies",
  icon: "/icons/fireflies.svg",
  apiDocsUrl: "https://docs.fireflies.ai/getting-started/introduction",
  description: "AI meeting transcripts, summaries, and action items.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiKey",
        label: "API Key",
        description:
          "Your Fireflies API key from Integrations → Fireflies API.",
        placeholder: "Paste your Fireflies API key",
        helpUrl: "https://app.fireflies.ai/integrations/custom/fireflies",
        helpLabel: "Get your API key",
      },
    ],
    resolveMetadata: async (fields) => {
      try {
        const res = await fetch("https://api.fireflies.ai/graphql", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${fields.apiKey}`,
          },
          body: JSON.stringify({ query: "{ user { name email } }" }),
        });
        if (res.ok) {
          const { data } = (await res.json()) as {
            data?: { user?: { name?: string; email?: string } };
          };
          const user = data?.user;
          if (user?.email || user?.name) {
            return {
              name: user.name,
              username: user.email ?? user.name,
              email: user.email,
            };
          }
        }
      } catch {
        // Non-fatal — connection still succeeds (labelled by user label or "API Key").
      }
      return null;
    },
  },
  labelHint: 'e.g. "personal", "work"',
};
