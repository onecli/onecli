import type { AppDefinition } from "./types";

export const affinity: AppDefinition = {
  id: "affinity",
  name: "Affinity",
  icon: "/icons/affinity.svg",
  darkIcon: "/icons/affinity.svg",
  description: "Manage relationships, deals, and interactions in Affinity CRM.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiKey",
        label: "API Key",
        description:
          "Your Affinity API key. Find it at Settings > API in Affinity.",
        placeholder: "Enter your API key",
      },
    ],
    resolveMetadata: async (fields) => {
      const res = await fetch("https://api.affinity.co/v2/auth/whoami", {
        headers: { Authorization: `Bearer ${fields.apiKey}` },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        user?: { firstName?: string; lastName?: string; emailAddress?: string };
        tenant?: { name?: string };
      };
      return {
        name: data.tenant?.name,
        username: data.user
          ? `${data.user.firstName} ${data.user.lastName}`
          : undefined,
        email: data.user?.emailAddress,
      };
    },
  },
};
