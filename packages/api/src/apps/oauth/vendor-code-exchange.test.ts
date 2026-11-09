import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthExchangeCodeParams } from "../types";
import { exchangeAtlassianCode } from "./atlassian";
import { exchangeGoogleCode } from "./google";
import { exchangeMicrosoftCode } from "./microsoft";

const NOW_S = Date.parse("2026-11-07T00:00:00Z") / 1000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const params = (
  callbackParams: Record<string, string> = { code: "auth-code" },
): OAuthExchangeCodeParams => ({
  appCredentials: { clientId: "client-1", clientSecret: "secret-1" },
  callbackParams,
  redirectUri: "https://api.example.com/v1/apps/oauth/vendor/callback",
});

const vendors = [
  {
    name: "Google",
    exchange: exchangeGoogleCode,
    tokenUrl: "https://oauth2.googleapis.com/token",
    profileUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    profile: { email: "dev@example.com", name: "Dev", picture: "https://p/1" },
    metadata: {
      username: "dev@example.com",
      name: "Dev",
      avatarUrl: "https://p/1",
    },
  },
  {
    name: "Microsoft",
    exchange: exchangeMicrosoftCode,
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    profileUrl: "https://graph.microsoft.com/v1.0/me",
    profile: {
      mail: "dev@example.com",
      userPrincipalName: "dev@tenant.example.com",
      displayName: "Dev",
    },
    metadata: { username: "dev@example.com", name: "Dev" },
  },
  {
    name: "Atlassian",
    exchange: exchangeAtlassianCode,
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    profileUrl: "https://api.atlassian.com/me",
    profile: { email: "dev@example.com", name: "Dev", picture: "https://p/1" },
    metadata: {
      username: "dev@example.com",
      name: "Dev",
      avatarUrl: "https://p/1",
    },
  },
] as const;

/** Answers the vendor's token URL with `token` and anything else with `user`. */
const stubFetch = (
  tokenUrl: string,
  token: () => Response,
  user: () => Response = () => json({}),
) => {
  const fetchMock = vi.fn<typeof fetch>(async (input) =>
    String(input) === tokenUrl ? token() : user(),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_S * 1000);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each(vendors)("$name code exchange", (vendor) => {
  const fullToken = {
    access_token: "at-1",
    refresh_token: "rt-1",
    expires_in: 3600,
    scope: "openid  email profile",
    token_type: "Bearer",
  };

  it("stores the tokens, splits the scopes and reads the profile with the new access token", async () => {
    const fetchMock = stubFetch(
      vendor.tokenUrl,
      () => json(fullToken),
      () => json(vendor.profile),
    );

    const result = await vendor.exchange(params());

    expect(result).toStrictEqual({
      credentials: {
        access_token: "at-1",
        refresh_token: "rt-1",
        token_type: "Bearer",
        expires_at: NOW_S + 3600,
      },
      scopes: ["openid", "email", "profile"],
      metadata: vendor.metadata,
    });
    expect(Object.keys(result.credentials)).toEqual([
      "access_token",
      "refresh_token",
      "token_type",
      "expires_at",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [profileUrl, profileInit] = fetchMock.mock.calls[1]!;
    expect(String(profileUrl)).toBe(vendor.profileUrl);
    expect(profileInit).toEqual({ headers: { Authorization: "Bearer at-1" } });
  });

  it("keeps absent token fields as undefined keys and no expiry when expires_in is missing or 0", async () => {
    for (const expires of [{}, { expires_in: 0 }]) {
      stubFetch(vendor.tokenUrl, () =>
        json({ access_token: "at-2", ...expires }),
      );

      const result = await vendor.exchange(params());

      expect(result.credentials).toStrictEqual({
        access_token: "at-2",
        refresh_token: undefined,
        token_type: undefined,
        expires_at: undefined,
      });
      expect(Object.keys(result.credentials)).toHaveLength(4);
      expect(result.scopes).toEqual([]);
    }
  });

  it("leaves metadata undefined when the profile request fails", async () => {
    const fetchMock = stubFetch(
      vendor.tokenUrl,
      () => json(fullToken),
      () => json({ error: "nope" }, 401),
    );

    const result = await vendor.exchange(params());

    expect(result.metadata).toBeUndefined();
    expect("metadata" in result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects when an OK profile response is not JSON", async () => {
    stubFetch(
      vendor.tokenUrl,
      () => json(fullToken),
      () => new Response("<html>", { status: 200 }),
    );

    await expect(vendor.exchange(params())).rejects.toThrow(SyntaxError);
  });

  it("throws the token response's error_description, without a profile call", async () => {
    const fetchMock = stubFetch(vendor.tokenUrl, () =>
      json({ error: "invalid_grant", error_description: "Code expired" }),
    );

    await expect(vendor.exchange(params())).rejects.toThrow(
      new Error("Code expired"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws the generic message for an error or a missing access token without a description", async () => {
    for (const body of [
      { error: "invalid_grant" },
      { error: "server_error", access_token: "at-3" },
      {},
    ]) {
      const fetchMock = stubFetch(vendor.tokenUrl, () => json(body));

      await expect(vendor.exchange(params())).rejects.toThrow(
        new Error("Failed to exchange code for token"),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects when an OK token response is not JSON", async () => {
    stubFetch(vendor.tokenUrl, () => new Response("not json"));

    await expect(vendor.exchange(params())).rejects.toThrow(SyntaxError);
  });
});

describe("token requests", () => {
  it.each([
    ["Google", exchangeGoogleCode, "https://oauth2.googleapis.com/token"],
    [
      "Microsoft",
      exchangeMicrosoftCode,
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    ],
  ] as const)(
    "%s posts the code as a form, in a fixed key order",
    async (_name, exchange, tokenUrl) => {
      const fetchMock = stubFetch(tokenUrl, () => json({ access_token: "a" }));

      await exchange(params());

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe(tokenUrl);
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        "Content-Type": "application/x-www-form-urlencoded",
      });
      expect([...(init?.body as URLSearchParams).entries()]).toEqual([
        ["code", "auth-code"],
        ["client_id", "client-1"],
        ["client_secret", "secret-1"],
        [
          "redirect_uri",
          "https://api.example.com/v1/apps/oauth/vendor/callback",
        ],
        ["grant_type", "authorization_code"],
      ]);
    },
  );

  it("Atlassian posts the code as JSON, in a fixed key order", async () => {
    const fetchMock = stubFetch("https://auth.atlassian.com/oauth/token", () =>
      json({ access_token: "a" }),
    );

    await exchangeAtlassianCode(params());

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://auth.atlassian.com/oauth/token");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(init?.body).toBe(
      '{"client_id":"client-1","client_secret":"secret-1","code":"auth-code","redirect_uri":"https://api.example.com/v1/apps/oauth/vendor/callback","grant_type":"authorization_code"}',
    );
  });

  it("Atlassian sends the request even without a code (the key is dropped)", async () => {
    const fetchMock = stubFetch("https://auth.atlassian.com/oauth/token", () =>
      json({ access_token: "a" }),
    );

    await exchangeAtlassianCode(params({}));

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      client_id: "client-1",
      client_secret: "secret-1",
      redirect_uri: "https://api.example.com/v1/apps/oauth/vendor/callback",
      grant_type: "authorization_code",
    });
  });
});

describe("token endpoint HTTP errors", () => {
  it.each([
    ["Google", exchangeGoogleCode, "https://oauth2.googleapis.com/token"],
    [
      "Microsoft",
      exchangeMicrosoftCode,
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    ],
  ] as const)(
    "%s includes the status, status text and raw body",
    async (name, exchange, tokenUrl) => {
      const fetchMock = stubFetch(
        tokenUrl,
        () =>
          new Response('{"error":"invalid_client"}', {
            status: 401,
            statusText: "Unauthorized",
          }),
      );

      await expect(exchange(params())).rejects.toThrow(
        new Error(
          `${name} token exchange failed: 401 Unauthorized ({"error":"invalid_client"})`,
        ),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("Atlassian includes the status and status text only", async () => {
    stubFetch(
      "https://auth.atlassian.com/oauth/token",
      () =>
        new Response('{"error":"invalid_client"}', {
          status: 403,
          statusText: "Forbidden",
        }),
    );

    await expect(exchangeAtlassianCode(params())).rejects.toThrow(
      new Error("Atlassian token exchange failed: 403 Forbidden"),
    );
  });
});

describe("callback errors before any request", () => {
  it.each([
    ["Google", exchangeGoogleCode],
    ["Microsoft", exchangeMicrosoftCode],
  ] as const)(
    "%s reports the provider error and a missing code",
    async (name, exchange) => {
      const fetchMock = stubFetch("unused", () => json({}));

      await expect(
        exchange(params({ error: "server_error", error_description: "Boom" })),
      ).rejects.toThrow(
        new Error(`${name} authorization error: server_error (Boom)`),
      );
      await expect(
        exchange(params({ error: "temporarily_unavailable" })),
      ).rejects.toThrow(
        new Error(
          `${name} authorization error: temporarily_unavailable (no description)`,
        ),
      );
      await expect(exchange(params({}))).rejects.toThrow(
        new Error(`${name} callback missing authorization code`),
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(["access_denied", "interaction_required", "consent_required"])(
    "Microsoft turns %s into the admin-approval message",
    async (error) => {
      stubFetch("unused", () => json({}));

      await expect(
        exchangeMicrosoftCode(params({ error, error_description: "x" })),
      ).rejects.toThrow(
        new Error(
          "Your organization requires admin approval for this app. Please ask your IT administrator to approve OneCLI, then try again.",
        ),
      );
    },
  );
});

describe("Microsoft profile", () => {
  it("falls back to userPrincipalName when mail is absent", async () => {
    stubFetch(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      () => json({ access_token: "a" }),
      () =>
        json({ userPrincipalName: "dev@tenant.example.com", displayName: "D" }),
    );

    const result = await exchangeMicrosoftCode(params());

    expect(result.metadata).toStrictEqual({
      username: "dev@tenant.example.com",
      name: "D",
    });
  });
});
