import type { AppDefinition } from "./types";

/**
 * AFFiNE connector (self-hosted instances).
 *
 * Cribbed from the Notion connector in spirit (workspace pages/docs), but
 * AFFiNE exposes a GraphQL API with personal access tokens rather than OAuth,
 * so the connection is a plain api_key. The instance hostname is per-deployment;
 * the gateway matches it via the AFFINE_HOST env var and gates injection on the
 * stored `host` field (see gateway apps.rs).
 */
export const affine: AppDefinition = {
  id: "affine",
  name: "AFFiNE",
  icon: "/icons/affine.svg",
  description: "Workspaces, docs, and collaboration on your AFFiNE instance.",
  connectionMethod: {
    type: "api_key",
    // Token MUST come first: the connect handler treats fields[0] as the
    // access token (credentials.access_token = fields[0]). Host second.
    fields: [
      {
        name: "token",
        label: "Access Token",
        description:
          "A personal access token from your AFFiNE instance (Settings → Access Tokens).",
        placeholder: "ut_...",
        secret: true,
      },
      {
        name: "host",
        label: "AFFiNE Host",
        description:
          "Your instance host (must match the gateway's AFFINE_HOST), e.g. affine.example.com",
        placeholder: "affine.example.com",
        secret: false,
      },
    ],
    resolveMetadata: async (fields) => {
      // Resolve the connected user via GraphQL. Non-fatal — fall back to the
      // host as the connection label.
      try {
        const res = await fetch(`https://${fields.host}/graphql`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${fields.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: "query { currentUser { name email } }",
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            data?: { currentUser?: { name?: string; email?: string } };
          };
          const user = data.data?.currentUser;
          if (user?.email || user?.name) {
            return {
              name: user.name ?? user.email,
              username: user.email ?? user.name,
              email: user.email,
              host: fields.host,
            };
          }
        }
      } catch {
        // Non-fatal
      }
      return { name: fields.host, username: fields.host };
    },
  },
  labelHint: 'e.g. "affine.int.example.com"',
  available: true,
};
