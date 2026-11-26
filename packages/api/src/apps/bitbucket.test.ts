import { afterEach, describe, expect, it, vi } from "vitest";
import { bitbucket } from "./bitbucket";

const method = bitbucket.connectionMethod;
if (method.type !== "oauth") throw new Error("bitbucket must be oauth");

const REDIRECT = "https://api.example.com/v1/apps/bitbucket/callback";
const creds = { clientId: "key-1", clientSecret: "secret-1" };
const exchange = (callbackParams: Record<string, string> = { code: "c-1" }) =>
  method.exchangeCode({
    appCredentials: creds,
    callbackParams,
    redirectUri: REDIRECT,
  });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

describe("bitbucket oauth", () => {
  it("builds the bitbucket.org authorize URL with no scope (fixed on the consumer)", async () => {
    const url = new URL(
      await method.buildAuthUrl({
        appCredentials: creds,
        redirectUri: REDIRECT,
        scopes: method.defaultScopes ?? [],
        state: "st-1",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://bitbucket.org/site/oauth2/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("key-1");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("st-1");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("scope")).toBeNull();
  });

  it("exchanges the code with Basic client auth and records the profile", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 7200,
          scopes: "account repository pullrequest:write",
          token_type: "bearer",
        }),
      )
      .mockResolvedValueOnce(
        json({
          username: "alex-kim",
          display_name: "Alex Kim",
          links: { avatar: { href: "https://avatar.example.com/a.png" } },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchange();

    const [tokenUrl, init] = fetchMock.mock.calls[0]!;
    expect(tokenUrl).toBe("https://bitbucket.org/site/oauth2/access_token");
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from("key-1:secret-1").toString("base64")}`,
    );
    const body = new URLSearchParams(init.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("c-1");
    expect(body.get("redirect_uri")).toBe(REDIRECT);
    // The secret never rides in the body.
    expect(body.get("client_secret")).toBeNull();

    expect(result.credentials).toMatchObject({
      access_token: "at-1",
      refresh_token: "rt-1",
    });
    expect(result.scopes).toEqual([
      "account",
      "repository",
      "pullrequest:write",
    ]);
    expect(result.metadata).toEqual({
      username: "alex-kim",
      name: "Alex Kim",
      avatarUrl: "https://avatar.example.com/a.png",
    });
  });

  it("connects without a profile when the profile read fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          json({ access_token: "at-1", refresh_token: "rt-1" }),
        )
        .mockRejectedValueOnce(new Error("network down")),
    );
    const result = await exchange();
    expect(result.credentials).toMatchObject({ access_token: "at-1" });
    expect(result.metadata).toBeUndefined();
  });

  it("shows Bitbucket's own reason when it refuses the code (400)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        json(
          {
            error: "invalid_request",
            error_description: "authorization_code is invalid",
          },
          400,
        ),
      ),
    );
    await expect(exchange({ code: "old" })).rejects.toThrow(
      "authorization_code is invalid",
    );
  });

  it("refuses a token response without a refresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(json({ access_token: "at-1" })),
    );
    await expect(exchange()).rejects.toThrow(
      "Invalid Bitbucket token response",
    );
  });

  it("stops before the token call when the consent screen was declined", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      exchange({
        error: "access_denied",
        error_description: "Call +1 555 0100 to restore access",
      }),
    ).rejects.toThrow(/^Bitbucket authorization failed$/);
    await expect(exchange({})).rejects.toThrow("missing authorization code");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
