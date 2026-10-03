import type { AppDefinition } from "./types";

const API_BASE = "https://api.apollo.io/api/v1";

interface ApolloProfile {
  id?: string;
  team_id?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
}

const profileMetadata = (
  profile: ApolloProfile,
): Record<string, unknown> | undefined => {
  const name = [profile.first_name, profile.last_name]
    .filter(Boolean)
    .join(" ");
  if (!profile.email && !name) return undefined;
  return {
    username: profile.email ?? name,
    email: profile.email,
    name: name || undefined,
    userId: profile.id,
    teamId: profile.team_id,
  };
};

export const apolloIo: AppDefinition = {
  id: "apollo-io",
  name: "Apollo.io",
  icon: "/icons/apollo-io.svg",
  description: "People and company search, enrichment, contacts, and deals.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiKey",
        label: "API key",
        description:
          "Create a key in Apollo under Settings → Integrations → API keys. Pick only the endpoints your agents need.",
        placeholder: "<your Apollo API key>",
        secret: true,
        helpUrl: "https://docs.apollo.io/docs/create-api-key",
        helpLabel: "How to create an Apollo API key",
      },
    ],
    resolveMetadata: async (fields) => {
      // The connect route has already rejected an empty key; this only
      // normalises whitespace the way the stored credential is normalised.
      const apiKey = fields.apiKey?.trim() ?? "";
      const res = await fetch(`${API_BASE}/users/api_profile`, {
        headers: { "x-api-key": apiKey },
      }).catch(() => null);
      // 401 = bad key: fail so we never store a dead connection. 403 is a
      // valid key that simply wasn't granted the profile endpoint, which is
      // fine for a narrowly scoped key.
      if (res?.status === 401) {
        throw new Error(
          "Apollo rejected this API key. Double-check the key and try again.",
        );
      }
      if (res?.ok) {
        const profile = (await res
          .json()
          .catch(() => null)) as ApolloProfile | null;
        if (profile) return profileMetadata(profile) ?? null;
      }
      return null;
    },
  },
};
