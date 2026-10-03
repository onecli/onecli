import { describe, expect, it, vi, afterEach } from "vitest";
vi.hoisted(() => {
  process.env.OAUTH_STATE_SECRET = "salesforce-test-signing-key";
});
import { salesforce, parseInstanceUrl } from "./salesforce";

const method = salesforce.connectionMethod;
if (method.type !== "oauth") throw new Error("expected an OAuth definition");

const credentials = {
  clientId: "consumer-key",
  clientSecret: "consumer-secret",
  environment: "production",
};

afterEach(() => vi.unstubAllGlobals());

describe("instance URL validation", () => {
  // The bug this pins: Developer Edition, scratch, patch and demo orgs live on
  // partitioned My Domain hosts. Rejecting them makes those orgs unconnectable,
  // and they are what most people evaluate with.
  it("accepts every real My Domain shape", () => {
    for (const host of [
      "acme.my.salesforce.com",
      "acme--dev.sandbox.my.salesforce.com",
      "acme-dev-ed.develop.my.salesforce.com",
      "orgfarm-0a1b2c3d4e-dev-ed.develop.my.salesforce.com",
      "acme.scratch.my.salesforce.com",
      "acme.patch.my.salesforce.com",
      "acme.trailblaze.my.salesforce.com",
    ]) {
      expect(parseInstanceUrl(`https://${host}`)).toBe(host);
    }
  });

  it("rejects anything that is not a bare Salesforce https origin", () => {
    for (const value of [
      "https://login.salesforce.com",
      "https://acme.my.salesforce.com.evil.test",
      "https://evil.test/?x=https://acme.my.salesforce.com",
      // Backslash smuggling: the parser reads the real host as evil.test.
      "https://evil.test\\@acme.my.salesforce.com",
      // Trailing dot is a distinct DNS name and must not pass as the org host.
      "https://acme.my.salesforce.com./",
      "http://acme.my.salesforce.com",
      "https://user:pw@acme.my.salesforce.com",
      "https://acme.my.salesforce.com:8443",
      "https://acme.my.salesforce.com/path",
      "https://acme.my.salesforce.com?q=1",
      "https://acme.my.salesforce.com#f",
      "https://my.salesforce.com",
      "not-a-url",
      undefined,
      null,
      42,
    ]) {
      expect(() => parseInstanceUrl(value)).toThrow();
    }
  });

  it("normalizes the casing Salesforce may vary", () => {
    // Hostnames are case-insensitive; the stored value must be canonical so the
    // gateway's exact host comparison matches.
    expect(parseInstanceUrl("https://ACME.My.Salesforce.com")).toBe(
      "acme.my.salesforce.com",
    );
  });
});

describe("authorization URL", () => {
  it("uses the environment's login host with S256 PKCE", async () => {
    const url = new URL(
      await method.buildAuthUrl({
        appCredentials: credentials,
        redirectUri: "https://api.onecli.sh/v1/apps/salesforce/callback",
        scopes: ["api", "refresh_token", "openid"],
        state: "signed-state",
      }),
    );
    expect(url.origin).toBe("https://login.salesforce.com");
    expect(url.pathname).toBe("/services/oauth2/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    // The verifier must never ride the front channel.
    expect(url.searchParams.has("code_verifier")).toBe(false);
  });

  it("sends sandbox connections to the sandbox login host", async () => {
    const url = new URL(
      await method.buildAuthUrl({
        appCredentials: { ...credentials, environment: "sandbox" },
        redirectUri: "https://api.onecli.sh/v1/apps/salesforce/callback",
        scopes: ["api"],
        state: "signed-state",
      }),
    );
    expect(url.origin).toBe("https://test.salesforce.com");
  });

  it("refuses an unknown environment rather than guessing a host", async () => {
    await expect(
      method.buildAuthUrl({
        appCredentials: { ...credentials, environment: "https://evil.test" },
        redirectUri: "https://api.onecli.sh/v1/apps/salesforce/callback",
        scopes: ["api"],
        state: "signed-state",
      }),
    ).rejects.toThrow(/production or sandbox/);
  });
});

describe("code exchange", () => {
  const stubFetch = (
    token: Record<string, unknown>,
    identity: Record<string, unknown> = {},
  ) => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href.endsWith("/token")) {
        return { ok: true, json: async () => token } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          user_id: "005xx0000012345AAA",
          organization_id: "00Dxx0000001gPFEAY",
          preferred_username: "agent@acme.com",
          name: "Agent User",
          ...identity,
        }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  const exchange = () =>
    method.exchangeCode({
      appCredentials: credentials,
      callbackParams: { code: "auth-code", state: "signed-state" },
      redirectUri: "https://api.onecli.sh/v1/apps/salesforce/callback",
    });

  it("stores the host binding, refresh endpoint and an expiry", async () => {
    stubFetch({
      access_token: "access",
      refresh_token: "refresh",
      instance_url: "https://acme.my.salesforce.com",
      scope: "api refresh_token openid",
    });
    const result = await exchange();

    expect(result.credentials.access_token).toBe("access");
    expect(result.credentials.refresh_token).toBe("refresh");
    // Pins gateway injection to this org only.
    expect(result.credentials.instance_host).toBe("acme.my.salesforce.com");
    // Salesforce omits expires_in, so the definition supplies one — without it
    // the gateway's expiry-driven refresh would never run. It must also sit
    // below Salesforce's 15-minute minimum session timeout, or a strict org
    // would expire the token while we still believed it was valid.
    const ttl =
      (result.credentials.expires_at as number) - Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15 * 60);
    expect(result.credentials.token_endpoint).toBe(
      "https://login.salesforce.com/services/oauth2/token",
    );
    expect(result.scopes).toEqual(["api", "refresh_token", "openid"]);
    expect(result.metadata?.username).toBe("agent@acme.com");
  });

  it("records the sandbox token endpoint for sandbox connections", async () => {
    stubFetch({
      access_token: "access",
      refresh_token: "refresh",
      instance_url: "https://acme--dev.sandbox.my.salesforce.com",
    });
    const result = await method.exchangeCode({
      appCredentials: { ...credentials, environment: "sandbox" },
      callbackParams: { code: "auth-code", state: "signed-state" },
      redirectUri: "https://api.onecli.sh/v1/apps/salesforce/callback",
    });
    expect(result.credentials.token_endpoint).toBe(
      "https://test.salesforce.com/services/oauth2/token",
    );
  });

  it("reads identity from the login host, never from the token payload", async () => {
    const fetchMock = stubFetch({
      access_token: "access",
      refresh_token: "refresh",
      instance_url: "https://acme.my.salesforce.com",
      id: "https://evil.test/id/attacker",
    });
    await exchange();
    const identityCall = fetchMock.mock.calls[1]?.[0]?.toString();
    expect(identityCall).toBe(
      "https://login.salesforce.com/services/oauth2/userinfo",
    );
  });

  it("rejects a token response bound to a non-Salesforce instance", async () => {
    stubFetch({
      access_token: "access",
      refresh_token: "refresh",
      instance_url: "https://evil.test",
    });
    await expect(exchange()).rejects.toThrow(/instance URL/);
  });

  it("requires a refresh token so the connection cannot silently die", async () => {
    stubFetch({
      access_token: "access",
      instance_url: "https://acme.my.salesforce.com",
    });
    await expect(exchange()).rejects.toThrow(/refresh token/);
  });
});
