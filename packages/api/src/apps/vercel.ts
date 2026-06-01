import type { AppDefinition } from "./types";

export const vercel: AppDefinition = {
  id: "vercel",
  name: "Vercel",
  icon: "/icons/vercel.svg",
  darkIcon: "/icons/vercel-light.svg",
  description: "Projects, deployments, domains, and environment variables.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiToken",
        label: "Access Token",
        description:
          "Your Vercel token. Create one at vercel.com/account/tokens",
        placeholder: "vcp_...",
      },
    ],
    resolveMetadata: async (fields) => {
      try {
        const res = await fetch("https://api.vercel.com/v2/user", {
          headers: { Authorization: `Bearer ${fields.apiToken}` },
        });
        if (res.ok) {
          const { user } = (await res.json()) as {
            user?: {
              email?: string;
              username?: string;
              name?: string;
              avatar?: string;
            };
          };
          if (user) {
            return {
              email: user.email,
              username: user.email ?? user.username,
              name: user.name ?? user.username,
              avatarUrl: user.avatar
                ? `https://api.vercel.com/www/avatar/${user.avatar}`
                : undefined,
            };
          }
        }
      } catch {
        // Non-fatal
      }
      return null;
    },
  },
  available: true,
};
