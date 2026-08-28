import type { AppDefinition } from "./types";

/** Normalize a pasted account host: accept a bare identifier, a full host, or
 *  a pasted URL, and return the bare host (no scheme, path, or port). */
const normalizeAccountHost = (raw: string): string => {
  let h = raw.trim().toLowerCase();
  const schemeIdx = h.indexOf("://");
  if (schemeIdx >= 0) h = h.slice(schemeIdx + 3);
  const slashIdx = h.indexOf("/");
  if (slashIdx >= 0) h = h.slice(0, slashIdx);
  const colonIdx = h.indexOf(":");
  if (colonIdx >= 0) h = h.slice(0, colonIdx);
  return h;
};

const resolveMetadata = async (
  fields: Record<string, string>,
): Promise<Record<string, unknown> | null> => {
  const host = normalizeAccountHost(fields.host ?? "");
  // Hard-fail a malformed host, for two reasons. (1) The gateway injects the
  // PAT only when the request host equals the stored host, so a bare account
  // identifier (or a typo'd domain) would store a connection that silently
  // never injects. (2) The validation fetch below sends the PAT as a Bearer
  // header, so the host must be a STRICT hostname under snowflakecomputing.com
  // — a permissive check (endsWith alone) would let a crafted value like
  // "evil.com#x.snowflakecomputing.com" route the fetch (and the token) to an
  // attacker-controlled origin via the URL fragment. The gateway normalizes
  // scheme/path/port away, so a pasted URL is fine.
  if (!/^[a-z0-9][a-z0-9.-]*\.snowflakecomputing\.com$/.test(host)) {
    throw new Error(
      "Account Host must be a full Snowflake host ending in .snowflakecomputing.com (e.g. myorg-myaccount.snowflakecomputing.com)",
    );
  }
  const account = host.replace(/\.snowflakecomputing\.com$/, "");
  const fallback = {
    name: account,
    url: `https://${host}`,
    tags: [account],
  };

  // Soft validation: a PAT can be perfectly valid yet unreachable from here
  // (Snowflake PATs require the user to be under a network policy, which may
  // not allow this server's egress IPs). Any failure falls through to the
  // host-derived label; a genuinely bad token then fails lazily at first use,
  // like JFrog.
  try {
    const res = await fetch(`https://${host}/api/v2/databases`, {
      headers: {
        Authorization: `Bearer ${fields.token ?? ""}`,
        "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      return { ...fallback, tags: [account, "verified"] };
    }
  } catch {
    // Fall through to the host-derived label.
  }

  return fallback;
};

export const snowflake: AppDefinition = {
  id: "snowflake",
  name: "Snowflake",
  icon: "/icons/snowflake.svg",
  description: "Run SQL and manage your Snowflake data cloud account.",
  connectionMethod: {
    type: "api_key",
    // Token MUST come first: the connect handler treats fields[0] as the
    // access token (credentials.access_token = fields[0]). Host second — the
    // gateway injects the PAT ONLY into this exact host (credential_host_field).
    fields: [
      {
        name: "token",
        label: "Programmatic Access Token",
        description:
          "A Snowflake programmatic access token (PAT). Note: using a PAT requires your Snowflake user to be subject to a network policy, or an authentication policy that lifts that requirement.",
        placeholder: "eyJra…",
        secret: true,
        helpUrl:
          "https://docs.snowflake.com/en/user-guide/programmatic-access-tokens#prerequisites",
        helpLabel: "How to create a PAT",
      },
      {
        name: "host",
        label: "Account Host",
        description:
          "Your account's host from Snowsight, e.g. myorg-myaccount.snowflakecomputing.com",
        placeholder: "myorg-myaccount.snowflakecomputing.com",
        secret: false,
      },
    ],
    resolveMetadata,
  },
  labelHint: 'e.g. "myorg-myaccount"',
};
