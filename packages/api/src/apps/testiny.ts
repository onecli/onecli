import type { AppDefinition } from "./types";

/**
 * Testiny connector.
 *
 * Testiny's REST API lives under https://app.testiny.io/api/v1 and
 * authenticates with an API key sent raw in the `X-Api-Key` header — no
 * Bearer prefix — so the connection is a plain api_key and the gateway
 * injects via `AuthStrategy::Header` (see app-permissions/testiny).
 */
export const testiny: AppDefinition = {
  id: "testiny",
  name: "Testiny",
  icon: "/icons/testiny.svg",
  darkIcon: "/icons/testiny-light.svg",
  description: "Test cases, test runs, plans, and results.",
  connectionMethod: {
    type: "api_key",
    // API key MUST come first: the connect handler treats fields[0] as the
    // access token (credentials.access_token = fields[0]).
    fields: [
      {
        name: "apiKey",
        label: "API Key",
        description:
          "Your Testiny API key. Create one under Settings → API Keys at app.testiny.io.",
        placeholder: "tny_...",
        secret: true,
      },
    ],
    resolveMetadata: async (fields) => {
      // Best-effort: surface the first project the key can see. Non-fatal —
      // the connection still works without metadata.
      try {
        const res = await fetch("https://app.testiny.io/api/v1/project", {
          headers: { "X-Api-Key": fields.apiKey! },
        });
        if (res.ok) {
          const body = (await res.json()) as
            | { name?: string }[]
            | { data?: { name?: string }[] };
          const projects = Array.isArray(body) ? body : (body.data ?? []);
          const name = projects.find((p) => p?.name)?.name;
          if (name) {
            return { name, username: name };
          }
        }
      } catch {
        // Non-fatal
      }
      return null;
    },
  },
  labelHint: 'e.g. "main", "nightly"',
  available: true,
};
