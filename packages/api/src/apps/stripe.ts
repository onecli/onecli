import type { AppDefinition } from "./types";

/**
 * Stripe authenticates with API keys — there is no user-facing OAuth for
 * reaching your OWN account. Stripe's Connect OAuth flow exists to attach
 * OTHER people's accounts to a marketplace platform, its docs say it "isn't
 * recommended for new platforms", and its token response marks `access_token`,
 * `refresh_token`, and `stripe_publishable_key` as DEPRECATED — the supported
 * path is a platform secret key plus a `Stripe-Account` header, which would
 * mean holding a key with rights over every connected account. Stripe's own
 * agent surface says the same thing: "MCP doesn't support OAuth ... instead,
 * authenticate with a restricted API key".
 *
 * So: an API key, and we steer hard toward a RESTRICTED key (`rk_`), which is
 * Stripe's explicit guidance for agents ("Stripe recommends always using RAKs
 * instead of unrestricted secret keys, especially when giving a key to an AI
 * agent"). The key's own permissions are the outer fence; OneCLI's per-tool
 * catalog is the inner one.
 */

/** Publishable keys are the one key type that is safe to expose — and useless
 *  here: they cannot read account data or perform any of the operations in the
 *  catalog. Catching the paste at connect time gives a real explanation instead
 *  of a puzzling 401 on the agent's first call. */
const PUBLISHABLE_KEY = /^pk_(test|live)_/;

/** Every key shape that can actually authenticate a server-side API request:
 *  restricted (`rk_`), secret (`sk_`), and organization keys. Organization
 *  keys are prefixed `sk_org` with NO trailing underscore guaranteed and no
 *  `rk_org` variant, so they are matched as their own alternative rather than
 *  folded into the `sk_` rule. */
const USABLE_KEY = /^(rk_(test|live)_|sk_org|sk_(test|live)_)/;

const resolveMetadata = async (
  fields: Record<string, string>,
): Promise<Record<string, unknown> | null> => {
  const apiKey = fields.apiKey?.trim() ?? "";

  if (PUBLISHABLE_KEY.test(apiKey)) {
    throw new Error(
      "That's a publishable key (pk_…), which can't read or change account data. Use a restricted key (rk_…) from the API keys page instead.",
    );
  }
  if (!USABLE_KEY.test(apiKey)) {
    throw new Error(
      "That doesn't look like a Stripe API key. Create a restricted key (rk_…) on the API keys page in your Stripe Dashboard.",
    );
  }

  const label = fields.label?.trim();
  // Live/test is read from the key text, so it is known even when the account
  // lookup below is skipped or fails. Organization keys (`sk_org…`) carry no
  // mode marker despite supporting both, so mode stays UNKNOWN for them rather
  // than being guessed — mislabelling a live key "test" is the dangerous
  // direction, since it invites treating real money as a sandbox.
  const livemode = apiKey.includes("_live_")
    ? true
    : apiKey.includes("_test_")
      ? false
      : undefined;
  const modeTag = livemode === undefined ? [] : [livemode ? "live" : "test"];
  const fallback: Record<string, unknown> = {
    ...(livemode === undefined ? {} : { livemode }),
    tags: modeTag,
    ...(label ? { name: label, username: label } : { name: "Stripe" }),
  };

  let res: Response | null = null;
  try {
    res = await fetch("https://api.stripe.com/v1/account", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Network/timeout — non-fatal, fall through to the key-derived label.
    return fallback;
  }

  // 401 is the ONLY response that proves the key itself is bad (Stripe returns
  // it for a malformed, expired, or revoked key). Fail loudly rather than
  // storing a connection that can never work.
  if (res.status === 401) {
    throw new Error(
      "Stripe rejected this API key. Check that it's current and hasn't been rotated or expired.",
    );
  }

  // 403 means the key is VALID but lacks the Account permission — the normal,
  // desirable state for a tightly-scoped restricted key. Never fail on it, or
  // we'd punish exactly the least-privilege setup Stripe recommends.
  if (!res.ok) return fallback;

  const account = (await res.json().catch(() => null)) as {
    id?: string;
    email?: string;
    business_profile?: { name?: string | null } | null;
    settings?: { dashboard?: { display_name?: string | null } | null } | null;
  } | null;
  if (!account?.id) return fallback;

  const accountName =
    account.settings?.dashboard?.display_name ??
    account.business_profile?.name ??
    account.email ??
    account.id;

  return {
    ...fallback,
    accountId: account.id,
    email: account.email,
    // An explicit label wins, so multiple keys for one account stay tellable
    // apart; otherwise fall back to what Stripe calls the account.
    name: label ?? accountName,
    username: label ?? accountName,
    // The Account object carries no `livemode` field, so the key text remains
    // the only mode signal — absent entirely for organization keys.
    tags: [...modeTag, account.id],
  };
};

export const stripe: AppDefinition = {
  id: "stripe",
  name: "Stripe",
  icon: "/icons/stripe.svg",
  description:
    "Payments, customers, subscriptions, invoices, and refunds on your Stripe account.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiKey",
        label: "Restricted API key",
        description:
          "Create a restricted key (rk_…) on the API keys page and grant it only the permissions your agents need. Stripe recommends restricted keys over secret keys for AI agents.",
        placeholder: "rk_live_...",
        secret: true,
        helpUrl: "https://docs.stripe.com/keys/restricted-api-keys",
        helpLabel: "How to create a restricted key",
      },
      {
        name: "label",
        label: "Label",
        description:
          'A name for this key so agents can reference it (e.g. "production", "sandbox")',
        placeholder: "e.g. production",
        optional: true,
        secret: false,
      },
    ],
    resolveMetadata,
  },
  labelHint: 'e.g. "production", "sandbox"',
};
