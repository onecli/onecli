import type { AppDefinition } from "./types";

// Clay's public API accepts only a personal API key (`clay-api-key` header).
// Clay's OAuth server issues tokens scoped to its MCP server only, so there
// is no OAuth option here.
export const clay: AppDefinition = {
  id: "clay",
  name: "Clay",
  // Clay publishes its Kiln mark only as a 3-D raster (brand kit at
  // clay.com → "Download brand assets"); there is no official flat vector.
  icon: "/icons/clay.png",
  description: "GTM data search, enrichment functions, and tables.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiKey",
        label: "API key",
        description:
          "Create one in Clay under Settings → Account → API keys. Keys are tied to your Clay user and workspace.",
        placeholder: "<your Clay API key>",
        secret: true,
        helpUrl: "https://university.clay.com/docs/guide-find-clay-api-key",
        helpLabel: "How to find your Clay API key",
      },
    ],
    resolveMetadata: async (fields) => {
      const apiKey = fields.apiKey?.trim() ?? "";
      const res = await fetch("https://api.clay.com/public/v0/me", {
        headers: { "clay-api-key": apiKey },
      }).catch(() => null);
      if (res?.status === 401 || res?.status === 403) {
        throw new Error(
          "Clay rejected this API key. Double-check the key and try again.",
        );
      }
      if (res?.ok) {
        const me = (await res.json().catch(() => null)) as {
          user?: { id?: string; name?: string | null; email?: string | null };
          workspace?: { id?: string; name?: string | null };
        } | null;
        if (me?.user) {
          return {
            username: me.user.email ?? me.user.name ?? undefined,
            email: me.user.email ?? undefined,
            name: me.user.name ?? undefined,
            workspaceName: me.workspace?.name ?? undefined,
            workspaceId: me.workspace?.id,
          };
        }
      }
      // Network or unexpected shape: non-fatal.
      return null;
    },
  },
  labelHint: 'e.g. "gtm-team", "personal"',
};
