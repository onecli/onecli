import { afterEach, describe, expect, it, vi } from "vitest";
import { github } from "./github";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GitHub OAuth token exchange", () => {
  it("keeps expiring GitHub App user tokens and their refresh-token expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T00:00:00.000Z"));

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);

      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({
          access_token: "test-access-token",
          token_type: "bearer",
          scope: "repo,user",
          expires_in: 28_800,
          refresh_token: "test-refresh-token",
          refresh_token_expires_in: 15_897_600,
        });
      }

      if (url === "https://api.github.com/user") {
        return Response.json({
          login: "test-user",
          name: "Test User",
          avatar_url: "https://example.com/avatar.png",
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const connectionMethod = github.connectionMethod;
    if (connectionMethod.type !== "oauth") {
      throw new Error("Expected GitHub to use OAuth");
    }

    const result = await connectionMethod.exchangeCode({
      appCredentials: {
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
      },
      callbackParams: { code: "test-code" },
      redirectUri: "http://localhost/callback",
    });

    const now = Math.floor(Date.now() / 1000);

    expect(result.credentials).toMatchObject({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      token_type: "bearer",
      expires_at: now + 28_800,
      refresh_token_expires_at: now + 15_897_600,
    });
  });

  it("accepts classic OAuth tokens that do not expire", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);

      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({
          access_token: "classic-access-token",
          token_type: "bearer",
          scope: "repo,user",
        });
      }

      if (url === "https://api.github.com/user") {
        return Response.json({ login: "classic-user" });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const connectionMethod = github.connectionMethod;
    if (connectionMethod.type !== "oauth") {
      throw new Error("Expected GitHub to use OAuth");
    }

    const result = await connectionMethod.exchangeCode({
      appCredentials: {
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
      },
      callbackParams: { code: "test-code" },
      redirectUri: "http://localhost/callback",
    });

    expect(result.credentials).toEqual({
      access_token: "classic-access-token",
      token_type: "bearer",
    });
  });
});
