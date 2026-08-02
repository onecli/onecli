import type { AppDefinition } from "./types";

export const vercel: AppDefinition = {
  id: "vercel",
  name: "Vercel",
  icon: "/icons/vercel.svg",
  darkIcon: "/icons/vercel-light.svg",
  description: "Deployments, projects, environment variables, and build logs.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiKey",
        label: "API Token",
        description:
          "Create a Personal Access Token in your Vercel Account Settings.",
        placeholder: "vbc_...",
        secret: true,
      },
    ],
    resolveMetadata: async (fields) => {
      const res = await fetch("https://api.vercel.com/v2/user", {
        headers: {
          Authorization: `Bearer ${fields.apiKey}`,
        },
      });

      if (!res.ok) {
        throw new Error("Invalid Vercel API Token");
      }

      const data = await res.json();
      return {
        username: data.user?.username || data.user?.email,
        email: data.user?.email,
        accountName: data.user?.name || data.user?.username,
      };
    },
  },
  labelHint: 'e.g. "production", "personal-account"',
  available: true,
};
