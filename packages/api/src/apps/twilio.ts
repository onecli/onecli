import type { AppDefinition, OAuthExchangeResult } from "./types";

// Twilio REST APIs with HTTP Basic auth (twilio.com/docs/usage/requests-to-twilio).
// The recommended credential is an API key: its SID (SK…) is the username and
// its secret the password. The Account SID (AC…) with the Auth Token works the
// same way, so both are accepted in the same two fields.
//
// Credentials are per region: an API key or Auth Token from US1 is refused in
// IE1 and AU1, and the reverse (twilio.com/docs/global-infrastructure). The
// user names the region, the probe below runs there, and the gateway rewrites
// any Twilio product host to that region's (see the gateway host rewrite).
//
// The connect step stores `access_token` as the joined `sid:secret` pair, the
// form the gateway's Basic strategy encodes, and `region` for the rewrite.
// The Account SID becomes the connection's label, because every 2010 API path
// is `/2010-04-01/Accounts/{AccountSid}/…` and an agent cannot guess it.

/** Twilio's processing regions and the API host each one answers on. */
const TWILIO_API_HOSTS = {
  us1: "api.twilio.com",
  ie1: "api.dublin.ie1.twilio.com",
  au1: "api.sydney.au1.twilio.com",
} as const;

type TwilioRegion = keyof typeof TWILIO_API_HOSTS;

const isTwilioRegion = (value: string): value is TwilioRegion =>
  Object.hasOwn(TWILIO_API_HOSTS, value);

/**
 * The region a submitted value names, or null for anything that is not one.
 * Only a normalized, known region may be stored: the gateway falls back to
 * US1 for anything else.
 */
export const normalizeTwilioRegion = (raw: string): TwilioRegion | null => {
  const region = raw.trim().toLowerCase();
  return isTwilioRegion(region) ? region : null;
};

// Twilio's SID shape: a two-letter uppercase prefix and 32 hex characters.
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const KEY_SID = /^SK[0-9a-fA-F]{32}$/;

/** The `account_sid` of a `Balance.json` answer, when it is a real one. */
const accountSidOf = (body: unknown): string | undefined => {
  const sid =
    typeof body === "object" && body !== null && "account_sid" in body
      ? body.account_sid
      : undefined;
  return typeof sid === "string" && ACCOUNT_SID.test(sid) ? sid : undefined;
};

const exchangeCredentials = async (
  fields: Record<string, string>,
): Promise<OAuthExchangeResult> => {
  const sid = fields.sid?.trim() ?? "";
  const secret = fields.secret?.trim() ?? "";
  const region = normalizeTwilioRegion(fields.region ?? "");
  if (!region) {
    throw new Error(
      'Region must be "us1", "ie1", or "au1" (where the key was created).',
    );
  }
  const isApiKey = KEY_SID.test(sid);
  if (!isApiKey && !ACCOUNT_SID.test(sid)) {
    throw new Error(
      "The SID should be an API key SID (starts with SK) or your Account SID (starts with AC), 34 characters.",
    );
  }
  if (!secret) {
    throw new Error("The API key secret (or Auth Token) is required.");
  }
  const regionTag = region.toUpperCase();

  // `Accounts/{sid}/Balance.json` resolves the account behind ANY credential:
  // Twilio accepts the key's own SID in the account slot, and Standard keys
  // may read it (unlike `/Accounts.json`, which only Main keys may). So one
  // call both proves the credential and names the account. Bounded: the
  // connect request awaits it.
  const res = await fetch(
    `https://${TWILIO_API_HOSTS[region]}/2010-04-01/Accounts/${sid}/Balance.json`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${secret}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(5000),
    },
  ).catch(() => null);

  // Twilio answers 401 for a wrong secret, a key from another region, and a
  // Restricted key without permission for the balance alike (20003 / 70051),
  // so the message names every cause the user can check.
  if (res?.status === 401) {
    throw new Error(
      `Twilio rejected these credentials in the ${regionTag} region. Check the SID and secret, that the key was created in ${regionTag}, and that it is a Standard key (a Restricted key needs permission to read the balance).`,
    );
  }

  let accountSid = isApiKey ? undefined : sid;
  if (res?.ok) {
    accountSid = accountSidOf(await res.json().catch(() => null)) ?? accountSid;
  }

  return {
    credentials: { access_token: `${sid}:${secret}`, region },
    scopes: [],
    metadata: {
      // The label agents see: they need the Account SID to build every
      // `/2010-04-01/Accounts/{AccountSid}/…` path. Not a secret.
      name: accountSid ?? "Twilio",
      tags: [regionTag, ...(isApiKey ? [] : ["Auth Token"])],
    },
  };
};

export const twilio: AppDefinition = {
  id: "twilio",
  setupGuideUrl: "https://onecli.sh/docs/integrations/twilio",
  name: "Twilio",
  apiDocsUrl: "https://www.twilio.com/docs/usage/api",
  // The Twilio mark in its brand red, which reads on light and dark
  // backgrounds, so no darkIcon.
  icon: "/icons/twilio.svg",
  description:
    "SMS, WhatsApp, voice, and verification. Send and read messages, place and review calls, look up and verify phone numbers.",
  connectionMethod: {
    type: "credentials_import",
    fields: [
      {
        name: "region",
        label: "Region",
        description:
          "The Twilio region the key was created in. Keys only work in their own region; most accounts use US1.",
        placeholder: "Select a region",
        secret: false,
        options: [
          { value: "us1", label: "United States (US1)" },
          { value: "ie1", label: "Ireland (IE1)" },
          { value: "au1", label: "Australia (AU1)" },
        ],
        defaultValue: "us1",
      },
      {
        name: "sid",
        label: "API key SID",
        description:
          "In the Twilio Console, open Account → API keys & tokens and create a Standard key. Starts with SK. Your Account SID (AC…) also works, with the Auth Token below.",
        placeholder: "SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        secret: false,
        helpUrl: "https://www.twilio.com/docs/iam/api-keys/keys-in-console",
        helpLabel: "How to create an API key",
      },
      {
        name: "secret",
        label: "API key secret",
        description:
          "Shown once, when the key is created. With an Account SID, paste the Auth Token instead.",
        placeholder: "<your API key secret>",
        secret: true,
      },
    ],
    exchangeCredentials,
  },
  labelHint: 'e.g. "production", "marketing-sms"',
};
