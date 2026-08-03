import type { AppDefinition } from "./types";

/**
 * MantisHub connector.
 *
 * MantisHub is hosted MantisBT on per-customer hosts (`<name>.mantishub.io`).
 * Its REST API authenticates with an API token sent raw in the Authorization
 * header — no scheme prefix — so the gateway injects via
 * `AuthStrategy::Header`, gated to the connection's stored host with
 * `credential_host_field` (cf. the JFrog Artifactory connector).
 */
export const mantishub: AppDefinition = {
  id: "mantishub",
  name: "MantisHub",
  icon: "/icons/mantishub.svg",
  darkIcon: "/icons/mantishub-light.svg",
  description: "Issues, projects, and filters in your MantisHub tracker.",
  connectionMethod: {
    type: "api_key",
    // Token MUST come first: the connect handler treats fields[0] as the
    // access token (credentials.access_token = fields[0]). Host second.
    fields: [
      {
        name: "token",
        label: "API Token",
        description:
          "Your MantisHub API token. Create one under My Account → API Tokens.",
        placeholder: "…",
        secret: true,
      },
      {
        name: "subdomain",
        label: "MantisHub Host",
        description: "Your MantisHub host, e.g. acme.mantishub.io",
        placeholder: "acme.mantishub.io",
        secret: false,
      },
    ],
    resolveMetadata: async (fields) => {
      // Best-effort: resolve the token's user. Only ever fetches the
      // *.mantishub.io host the gateway would inject to; anything else just
      // echoes the host (the gateway's host gate would refuse it anyway).
      const host = fields.subdomain?.trim().toLowerCase();
      if (host && /^[a-z0-9-]+\.mantishub\.io$/.test(host)) {
        try {
          const res = await fetch(`https://${host}/api/rest/users/me`, {
            headers: { Authorization: fields.token! },
          });
          if (res.ok) {
            const user = (await res.json()) as {
              name?: string;
              real_name?: string;
              email?: string;
            };
            const name = user.real_name ?? user.name;
            if (name) {
              return { name, username: user.name ?? name, email: user.email };
            }
          }
        } catch {
          // Non-fatal
        }
      }
      return { name: fields.subdomain, username: fields.subdomain };
    },
  },
  labelHint: 'e.g. "acme.mantishub.io"',
  available: true,
};
