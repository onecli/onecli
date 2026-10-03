import type { AppDefinition } from "./types";

// PostHog Cloud runs two regions. The REST API is region-specific, so API
// keys are probed against both.
const REGION_HOSTS = {
  us: "https://us.posthog.com",
  eu: "https://eu.posthog.com",
} as const;
type Region = keyof typeof REGION_HOSTS;

interface PostHogMe {
  uuid?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  organization?: { id?: string; name?: string };
  team?: { id?: number; name?: string };
}

const meMetadata = (me: PostHogMe, region: Region) => {
  const name = [me.first_name, me.last_name].filter(Boolean).join(" ");
  return {
    username: me.email ?? name,
    email: me.email,
    name: name || undefined,
    organizationName: me.organization?.name,
    organizationId: me.organization?.id,
    projectName: me.team?.name,
    projectId: me.team?.id,
    region,
  };
};

export const posthog: AppDefinition = {
  id: "posthog",
  name: "PostHog",
  icon: "/icons/posthog.svg",
  darkIcon: "/icons/posthog-light.svg",
  description: "Product analytics, insights, feature flags, and experiments.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiKey",
        label: "Personal API key",
        description:
          "Create one in PostHog under Settings → User → Personal API keys. Grant only the scopes your agents need, and include User: read so OneCLI can show which account is connected.",
        placeholder: "phx_...",
        secret: true,
        helpUrl: "https://posthog.com/docs/api/personal-api-keys",
        helpLabel: "How to create a personal API key",
      },
    ],
    resolveMetadata: async (fields) => {
      const key = fields.apiKey?.trim() ?? "";
      if (!key.startsWith("phx_")) {
        throw new Error(
          "That doesn't look like a PostHog personal API key (they start with \"phx_\"). Project API keys (phc_) can't read data.",
        );
      }
      let rejected = 0;
      for (const region of Object.keys(REGION_HOSTS) as Region[]) {
        const res = await fetch(`${REGION_HOSTS[region]}/api/users/@me/`, {
          headers: { Authorization: `Bearer ${key}` },
        }).catch(() => null);
        if (res?.ok) {
          const me = (await res.json().catch(() => null)) as PostHogMe | null;
          if (me) return meMetadata(me, region);
        }
        // A key lives in one region, so the other always answers 401.
        if (res?.status === 401) rejected++;
        // 403 = valid key without the user:read scope. Keep it.
        if (res?.status === 403) return { region, name: "API Key" };
      }
      if (rejected === Object.keys(REGION_HOSTS).length) {
        throw new Error(
          "PostHog rejected this API key in both the US and EU regions. Double-check the key.",
        );
      }
      return null;
    },
  },
};
