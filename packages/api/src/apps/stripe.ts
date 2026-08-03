import type { AppDefinition } from "./types";

/**
 * Stripe connector.
 *
 * Stripe's REST API (https://api.stripe.com) authenticates with a secret or
 * restricted key sent as a Bearer token, so the connection is a plain api_key
 * (cf. the Resend/Fly.io connectors). The gateway gates injection on the
 * api.stripe.com and files.stripe.com hosts (see app-permissions/stripe).
 */
export const stripe: AppDefinition = {
  id: "stripe",
  name: "Stripe",
  icon: "/icons/stripe.svg",
  darkIcon: "/icons/stripe-light.svg",
  description: "Payments, Connect accounts, payouts, disputes, and refunds.",
  connectionMethod: {
    type: "api_key",
    // API key MUST come first: the connect handler treats fields[0] as the
    // access token (credentials.access_token = fields[0]).
    fields: [
      {
        name: "apiKey",
        label: "Secret Key",
        description:
          "Your Stripe secret or restricted key. Create one at dashboard.stripe.com/apikeys — a restricted key scoped to what your agent needs is recommended.",
        placeholder: "sk_... or rk_...",
        secret: true,
      },
    ],
    resolveMetadata: async (fields) => {
      // Resolve the account behind the key. Non-fatal — restricted keys
      // without Account read still connect, just without metadata.
      try {
        const res = await fetch("https://api.stripe.com/v1/account", {
          headers: { Authorization: `Bearer ${fields.apiKey}` },
        });
        if (res.ok) {
          const account = (await res.json()) as {
            id?: string;
            email?: string;
            business_profile?: { name?: string };
            settings?: { dashboard?: { display_name?: string } };
          };
          const name =
            account.settings?.dashboard?.display_name ??
            account.business_profile?.name ??
            account.email ??
            account.id;
          if (name) {
            return {
              name,
              username: account.email ?? account.id,
              email: account.email,
            };
          }
        }
      } catch {
        // Non-fatal
      }
      return null;
    },
  },
  labelHint: 'e.g. "live", "test"',
  available: true,
};
