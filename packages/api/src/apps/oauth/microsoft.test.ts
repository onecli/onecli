import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMicrosoftAuthUrl, exchangeMicrosoftCode } from "./microsoft";

const authParams = {
  appCredentials: { clientId: "client-123", clientSecret: "secret-456" },
  redirectUri: "https://app.example.com/callback",
  scopes: ["openid", "offline_access", "Mail.ReadWrite"],
  state: "state-abc",
};

describe("buildMicrosoftAuthUrl", () => {
  it("builds a v2.0 authorize URL on the common tenant", () => {
    const url = new URL(buildMicrosoftAuthUrl(authParams));
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("response_mode")).toBe("query");
    expect(url.searchParams.get("scope")).toBe(
      "openid offline_access Mail.ReadWrite",
    );
    expect(url.searchParams.get("state")).toBe("state-abc");
  });
});

const exchangeParams = {
  appCredentials: { clientId: "client-123", clientSecret: "secret-456" },
  callbackParams: { code: "auth-code-789" },
  redirectUri: "https://app.example.com/callback",
};

const tokenResponse = {
  access_token: "at-111",
  refresh_token: "rt-222",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "openid offline_access Mail.ReadWrite",
};

const meResponse = {
  userPrincipalName: "dewey@example.com",
  mail: "dewey@example.com",
  displayName: "Dewey Sasser",
};

const jsonRes = (body: unknown, ok = true, status = 200) =>
  ({
    ok,
    status,
    statusText: ok ? "OK" : "Bad Request",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as Response;

describe("exchangeMicrosoftCode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exchanges the code and fetches /me metadata", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(tokenResponse))
      .mockResolvedValueOnce(jsonRes(meResponse));
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchangeMicrosoftCode(exchangeParams);

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(tokenUrl).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    );
    const body = new URLSearchParams(tokenInit.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-789");
    expect(body.get("client_id")).toBe("client-123");
    expect(body.get("client_secret")).toBe("secret-456");

    expect(result.credentials.access_token).toBe("at-111");
    expect(result.credentials.refresh_token).toBe("rt-222");
    expect(typeof result.credentials.expires_at).toBe("number");
    expect(result.scopes).toEqual([
      "openid",
      "offline_access",
      "Mail.ReadWrite",
    ]);
    expect(result.metadata).toEqual({
      username: "dewey@example.com",
      name: "Dewey Sasser",
    });
  });

  it("throws on an error callback param", async () => {
    await expect(
      exchangeMicrosoftCode({
        ...exchangeParams,
        callbackParams: {
          error: "access_denied",
          error_description: "user cancelled",
        },
      }),
    ).rejects.toThrow(/access_denied/);
  });

  it("throws when the callback has no code", async () => {
    await expect(
      exchangeMicrosoftCode({ ...exchangeParams, callbackParams: {} }),
    ).rejects.toThrow(/missing authorization code/);
  });

  it("throws when the token endpoint returns non-200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(jsonRes({ error: "bad" }, false, 400)),
    );
    await expect(exchangeMicrosoftCode(exchangeParams)).rejects.toThrow(
      /token exchange failed/,
    );
  });

  it("tolerates a failed /me metadata fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonRes(tokenResponse))
        .mockResolvedValueOnce(jsonRes({}, false, 500)),
    );
    const result = await exchangeMicrosoftCode(exchangeParams);
    expect(result.credentials.access_token).toBe("at-111");
    expect(result.metadata).toBeUndefined();
  });
});
