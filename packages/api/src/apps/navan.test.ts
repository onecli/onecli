import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanNavanValue, navan, parseNavanRegion } from "./navan";
import {
  ALLOWED_TOKEN_URLS,
  ClientCredentialsExchangeError,
  exchangeClientCredentials,
} from "./oauth/client-credentials";

const method = navan.connectionMethod;
if (method.type !== "credentials_import") {
  throw new Error("navan must be a credentials_import app");
}
const { exchangeCredentials } = method;

const US_TOKEN = "https://app.navan.com/ta-auth/oauth/token";
const EU_TOKEN = "https://app-fra.navan.com/ta-auth/oauth/token";

const tokenResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: "",
  json: async () => body,
  text: async () => JSON.stringify(body),
});

// The shape Navan actually returned for a live test credential (token redacted).
const NAVAN_OK = {
  access_token: "tok",
  token_type: "bearer",
  expires_in: 43199,
  scope: "bookings:read liquid:read liquid:write",
  company_uuid: "00000000-0000-4000-8000-000000000001",
  allowed_ips: null,
};

const stubFetch = (body: unknown = NAVAN_OK, status = 200) => {
  const fetchMock = vi.fn().mockResolvedValue(tokenResponse(body, status));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("parseNavanRegion", () => {
  it("defaults to us and normalizes case and whitespace", () => {
    expect(parseNavanRegion(undefined)).toBe("us");
    expect(parseNavanRegion("")).toBe("us");
    expect(parseNavanRegion("  EU \n")).toBe("eu");
  });

  // A prototype key must not pass as a region (`in` would accept it).
  it.each(["apac", "toString", "__proto__", "https://evil.example"])(
    "rejects %s",
    (raw) => {
      expect(() => parseNavanRegion(raw)).toThrow(/Region must be/);
    },
  );
});

describe("cleanNavanValue", () => {
  const UUID =
    /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/gi;
  const HEX32 = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi;
  const KEY = "873c5e26ab6b4414a9f96db4d2c7bf12";
  const ID = "168c1f94-a55d-40a9-ad99-80113e62002c";

  it.each([
    [KEY, KEY],
    [`Secret Key: ${KEY}`, KEY],
    [`secret key:${KEY}`, KEY],
    [`"${KEY}"`, KEY],
    [`\u200B${KEY}\uFEFF\n`, KEY],
    [`Secret Key\n\u{1F517} ${KEY}   Copy key`, KEY],
  ])("secret %j -> key", (raw, expected) => {
    expect(cleanNavanValue(raw, HEX32)).toBe(expected);
  });

  it.each([
    [ID, ID],
    [`Client ID: ${ID}`, ID],
    [`Client ID:\n${ID.toUpperCase()}`, ID.toUpperCase()],
  ])("client id %j -> id", (raw, expected) => {
    expect(cleanNavanValue(raw, UUID)).toBe(expected);
  });

  it("does not cut a 32-hex run out of a longer value", () => {
    const long = `${KEY}abcd`;
    expect(cleanNavanValue(`Secret Key: ${long}`, HEX32)).toBe(long);
  });

  it("falls back to label and quote stripping for an unexpected format", () => {
    expect(cleanNavanValue("Secret Key: 'new-format-secret'", HEX32)).toBe(
      "new-format-secret",
    );
  });

  it("leaves input with two candidate keys for Navan to judge", () => {
    const other = "0".repeat(32);
    expect(cleanNavanValue(`${KEY} ${other}`, HEX32)).toBe(`${KEY} ${other}`);
  });

  it("returns empty for missing or invisible-only input", () => {
    expect(cleanNavanValue(undefined, HEX32)).toBe("");
    expect(cleanNavanValue("  \u200B ", HEX32)).toBe("");
  });

  it("stays fast on a long run of quotes", () => {
    const start = performance.now();
    expect(cleanNavanValue(`${'"'.repeat(200_000)}x`, HEX32)).toBe("x");
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("navan exchangeCredentials", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("US: posts to the US token host with Basic auth and stores no region header", async () => {
    const fetchMock = stubFetch();
    const result = await exchangeCredentials({
      clientId: " id ",
      clientSecret: "secret\n",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(US_TOKEN);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("id:secret").toString("base64")}`,
    );
    // Navan narrows the token to an explicit `scope` param, so none is sent.
    expect(init.body).toBe("grant_type=client_credentials");

    expect(result.credentials).toMatchObject({
      type: "client_credentials",
      access_token: "tok",
      client_id: "id",
      client_secret: "secret",
      token_url: US_TOKEN,
    });
    expect(result.credentials).not.toHaveProperty("ta_region");
    expect(result.scopes).toEqual([
      "bookings:read",
      "liquid:read",
      "liquid:write",
    ]);
    expect(result.metadata).toEqual({
      name: "Navan (US)",
      companyUuid: NAVAN_OK.company_uuid,
      tags: ["US"],
    });
  });

  it("EU: posts to the EU token host and stores ta_region for the gateway header", async () => {
    const fetchMock = stubFetch();
    const result = await exchangeCredentials({
      clientId: "id",
      clientSecret: "secret",
      region: "eu",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(EU_TOKEN);
    expect(result.credentials).toMatchObject({
      token_url: EU_TOKEN,
      ta_region: "EU",
    });
    expect(result.metadata).toMatchObject({ name: "Navan (EU)" });
  });

  it("rejects an unknown region before any network call", async () => {
    const fetchMock = stubFetch();
    await expect(
      exchangeCredentials({ clientId: "id", clientSecret: "s", region: "xx" }),
    ).rejects.toThrow(/Region must be/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires both client id and secret", async () => {
    const fetchMock = stubFetch();
    await expect(
      exchangeCredentials({ clientId: "id", clientSecret: "  " }),
    ).rejects.toThrow(/required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces Navan's rejection of bad credentials", async () => {
    stubFetch({ error: "invalid_client" }, 401);
    await expect(
      exchangeCredentials({ clientId: "id", clientSecret: "bad" }),
    ).rejects.toThrow(
      /Navan rejected this Client ID \/ Secret Key for the US region.*\(Token exchange failed \(401\): invalid_client\)/,
    );
  });

  it("strips the labels Navan's admin page copies along with the values", async () => {
    const fetchMock = stubFetch();
    await exchangeCredentials({
      clientId: "Client ID:\n168c1f94-a55d-40a9-ad99-80113e62002c",
      clientSecret: "Secret Key: 873c5e26ab6b4414a9f96db4d2c7bf12  Copy key",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from(
        "168c1f94-a55d-40a9-ad99-80113e62002c:873c5e26ab6b4414a9f96db4d2c7bf12",
      ).toString("base64")}`,
    );
  });

  it("passes a non-auth token failure through unchanged", async () => {
    // A Navan outage is not the user's credentials: keep the status visible.
    stubFetch({ error: "server_error" }, 503);
    await expect(
      exchangeCredentials({ clientId: "id", clientSecret: "s" }),
    ).rejects.toThrow(/Token exchange failed \(503\)/);
  });

  it("fails a credential that was created with no scopes", async () => {
    stubFetch({ ...NAVAN_OK, scope: "" });
    await expect(
      exchangeCredentials({ clientId: "id", clientSecret: "s" }),
    ).rejects.toThrow(/no scopes/);
  });

  it("omits companyUuid when Navan does not return one", async () => {
    stubFetch({ ...NAVAN_OK, company_uuid: undefined });
    const result = await exchangeCredentials({
      clientId: "id",
      clientSecret: "s",
    });
    expect(result.metadata).toEqual({ name: "Navan (US)", tags: ["US"] });
  });
});

describe("exchangeClientCredentials token URL allowlist", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists both Navan token hosts and Atlas", () => {
    expect(ALLOWED_TOKEN_URLS).toEqual(
      expect.arrayContaining([
        US_TOKEN,
        EU_TOKEN,
        "https://cloud.mongodb.com/api/oauth/token",
      ]),
    );
  });

  // The stored token_url is where the gateway later POSTs the client secret.
  it.each([
    "https://evil.example/token",
    "http://app.navan.com/ta-auth/oauth/token",
    "https://app.navan.com/ta-auth/oauth/token?x=1",
    "https://app.navan.com.evil.example/ta-auth/oauth/token",
  ])("refuses %s without sending the secret", async (tokenUrl) => {
    const fetchMock = stubFetch();
    await expect(
      exchangeClientCredentials({
        tokenUrl,
        clientId: "id",
        clientSecret: "s",
      }),
    ).rejects.toThrow(/not an allowed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the raw token response for provider metadata", async () => {
    stubFetch();
    const result = await exchangeClientCredentials({
      tokenUrl: US_TOKEN,
      clientId: "id",
      clientSecret: "s",
    });
    expect(result.tokenResponse.company_uuid).toBe(NAVAN_OK.company_uuid);
  });

  it("reports a non-2xx token response with its status and OAuth reason", async () => {
    stubFetch(
      { error: "invalid_client", error_description: "Bad client" },
      401,
    );
    const failing = exchangeClientCredentials({
      tokenUrl: US_TOKEN,
      clientId: "id",
      clientSecret: "bad",
    });
    await expect(failing).rejects.toBeInstanceOf(
      ClientCredentialsExchangeError,
    );
    await expect(failing).rejects.toMatchObject({
      status: 401,
      message: "Token exchange failed (401): Bad client",
    });
  });

  it("never reflects a non-JSON upstream body into the error", async () => {
    // The message reaches the connect form: an HTML error page from a proxy
    // must not come back verbatim.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        json: async () => {
          throw new SyntaxError("not json");
        },
      }),
    );
    await expect(
      exchangeClientCredentials({
        tokenUrl: US_TOKEN,
        clientId: "id",
        clientSecret: "s",
      }),
    ).rejects.toThrow("Token exchange failed (502): Bad Gateway");
  });
});
