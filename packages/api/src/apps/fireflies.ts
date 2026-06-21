import type { AppDefinition } from "./types";

/**
 * Fireflies.ai connector.
 *
 * Fireflies exposes a single GraphQL endpoint (https://api.fireflies.ai/graphql)
 * authenticated with a personal API key sent as a Bearer token, so the
 * connection is a plain api_key (cf. the Resend/AFFiNE connectors). The gateway
 * gates injection on the api.fireflies.ai host (see app-permissions/fireflies).
 */
export const fireflies: AppDefinition = {
  id: "fireflies",
  name: "Fireflies.ai",
  icon: "/icons/fireflies.svg",
  description: "Meeting transcripts, summaries, soundbites, and AskFred.",
  connectionMethod: {
    type: "api_key",
    // API key MUST come first: the connect handler treats fields[0] as the
    // access token (credentials.access_token = fields[0]).
    fields: [
      {
        name: "apiKey",
        label: "API Key",
        description:
          "Your Fireflies API key. Find it under Settings → Integrations → Fireflies API at fireflies.ai.",
        placeholder: "fk_...",
        secret: true,
      },
    ],
    resolveMetadata: async (fields) => {
      // Resolve the connected user via GraphQL. Non-fatal — the connection
      // still works without metadata.
      try {
        const res = await fetch("https://api.fireflies.ai/graphql", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${fields.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: "query { user { name email } }",
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            data?: { user?: { name?: string; email?: string } };
          };
          const user = data.data?.user;
          if (user?.email || user?.name) {
            return {
              name: user.name ?? user.email,
              username: user.email ?? user.name,
              email: user.email,
            };
          }
        }
      } catch {
        // Non-fatal
      }
      return null;
    },
  },
  labelHint: 'e.g. "work", "personal"',
  available: true,
};
