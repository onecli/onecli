import type { AppDefinition } from "./types";

export const flyio: AppDefinition = {
  id: "flyio",
  name: "Fly.io",
  icon: "/icons/flyio.svg",
  description:
    "Deploy and manage applications, Machines, volumes, and secrets on Fly.io.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiToken",
        label: "API Token",
        description:
          "Your Fly.io token. Create one at fly.io/dashboard or run fly tokens create org",
        placeholder: "FlyV1 fm2_...",
      },
    ],
    resolveMetadata: async (fields) => {
      try {
        const res = await fetch("https://api.fly.io/graphql", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${fields.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: "{ viewer { name email } }",
          }),
        });
        if (res.ok) {
          const { data } = (await res.json()) as {
            data?: { viewer?: { name?: string; email?: string } };
          };
          if (data?.viewer?.email) {
            return {
              email: data.viewer.email,
              username: data.viewer.email,
              name: data.viewer.name || data.viewer.email,
            };
          }
        }
      } catch {
        // Non-fatal
      }
      return null;
    },
  },
  labelHint: 'e.g. "production", "side-project"',
  available: true,
};
