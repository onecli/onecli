import type { AppDefinition, OAuthExchangeResult } from "./types";

interface AirbyteBaseUrl {
  apiBaseUrl: string;
  tokenUrl: string;
  baseAuthority: string;
  baseHost: string;
  basePath: string;
}

interface AirbyteTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

const AIRBYTE_REQUEST_TIMEOUT_MS = 10_000;

const redactError = (
  value: string,
  clientId: string,
  clientSecret: string,
): string =>
  value
    .replaceAll(clientSecret, "[REDACTED]")
    .replaceAll(clientId, "[REDACTED]")
    .slice(0, 500);

export const normalizeAirbyteBaseUrl = (rawValue: string): AirbyteBaseUrl => {
  let url: URL;
  try {
    url = new URL(rawValue.trim());
  } catch {
    throw new Error("Enter a valid Airbyte instance URL");
  }

  if (url.protocol !== "https:") {
    throw new Error("Airbyte instance URL must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Airbyte instance URL cannot contain credentials, query parameters, or a fragment",
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(
      "Airbyte instance URL must be an origin without a reverse-proxy subpath",
    );
  }

  const basePath = "/api/public/v1";
  return {
    apiBaseUrl: `${url.origin}${basePath}`,
    tokenUrl: `${url.origin}/api/v1/applications/token`,
    baseAuthority: url.host.toLowerCase(),
    baseHost: url.hostname.toLowerCase(),
    basePath,
  };
};

const requestAirbyteToken = async (
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  grantTypeField: "grant-type" | "grant_type",
): Promise<{ response: Response; data: AirbyteTokenResponse | null }> => {
  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        [grantTypeField]: "client_credentials",
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(AIRBYTE_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "network error";
    throw new Error(
      `Airbyte token request failed: ${redactError(
        message,
        clientId,
        clientSecret,
      )}`,
    );
  }

  const data = (await response
    .json()
    .catch(() => null)) as AirbyteTokenResponse | null;
  return { response, data };
};

export const exchangeAirbyteCredentials = async (
  fields: Record<string, string>,
): Promise<OAuthExchangeResult> => {
  const { baseUrl, clientId, clientSecret } = fields;
  if (!baseUrl || !clientId || !clientSecret) {
    throw new Error("Airbyte URL, Client ID, and Client Secret are required");
  }

  const normalized = normalizeAirbyteBaseUrl(baseUrl);
  let result = await requestAirbyteToken(
    normalized.tokenUrl,
    clientId,
    clientSecret,
    "grant-type",
  );

  if (
    !result.response.ok &&
    (result.response.status === 400 || result.response.status === 422)
  ) {
    result = await requestAirbyteToken(
      normalized.tokenUrl,
      clientId,
      clientSecret,
      "grant_type",
    );
  }

  if (!result.response.ok || !result.data?.access_token) {
    const upstreamMessage =
      result.data?.error_description ??
      result.data?.error ??
      result.response.statusText ??
      "unknown error";
    throw new Error(
      `Airbyte token exchange failed (${result.response.status}): ${redactError(
        upstreamMessage,
        clientId,
        clientSecret,
      )}`,
    );
  }

  const expiresAt =
    Math.floor(Date.now() / 1000) +
    Math.max((result.data.expires_in ?? 3600) - 30, 1);

  return {
    credentials: {
      type: "airbyte_client_credentials",
      access_token: result.data.access_token,
      expires_at: expiresAt,
      client_id: clientId,
      client_secret: clientSecret,
      token_url: normalized.tokenUrl,
      api_base_url: normalized.apiBaseUrl,
      base_authority: normalized.baseAuthority,
      base_host: normalized.baseHost,
      base_path: normalized.basePath,
    },
    scopes: [],
    metadata: {
      name: `${normalized.baseHost}${normalized.basePath}`,
      apiBaseUrl: normalized.apiBaseUrl,
      baseAuthority: normalized.baseAuthority,
      baseHost: normalized.baseHost,
      basePath: normalized.basePath,
    },
  };
};

export const airbyte: AppDefinition = {
  id: "airbyte",
  name: "Airbyte (Self-Managed)",
  icon: "/icons/airbyte.svg",
  description:
    "Connect a self-managed Airbyte instance with automatic token refresh. Airbyte Cloud uses a separate API host and connection flow.",
  connectionMethod: {
    type: "credentials_import",
    persistClientCredentialsAsAppConfig: false,
    fields: [
      {
        name: "baseUrl",
        label: "Airbyte Instance URL",
        description:
          "Your self-managed Airbyte origin. OneCLI derives the token and Public API paths automatically.",
        placeholder: "https://airbyte.example.com",
        secret: false,
      },
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "Airbyte application client ID",
        secret: false,
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "Airbyte application client secret",
        secret: true,
      },
    ],
    exchangeCredentials: exchangeAirbyteCredentials,
  },
  connectionIdentity: {
    metadataKey: "apiBaseUrl",
    normalize: "exact",
  },
  privilegedConnect: true,
  labelHint: 'e.g. "production", "staging"',
  available: true,
};
