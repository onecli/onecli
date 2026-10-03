import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackApiError } from "@onecli/channels/slack";
import { DeadIntegrationCredentialError } from "../../errors";

vi.hoisted(() => {
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

const stored = JSON.stringify({
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: Math.floor(Date.now() / 1000) + 300,
});

afterEach(() => vi.unstubAllGlobals());

describe("Slack rotation permanent refusal classification", () => {
  it.each([
    ["invalid_refresh_token", true],
    ["invalid_auth", true],
    ["token_revoked", true],
    ["token_expired", true],
    ["account_inactive", true],
    ["ratelimited", false],
    ["internal_error", false],
    ["unknown_error", false],
  ])(
    "classifies an actual %s response as permanent=%s",
    async (code, permanent) => {
      const { slackProvider } = await import("./provider");
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ ok: false, error: code })),
          ),
      );
      const error = await slackProvider
        .rotateIntegrationCredential(stored)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(
        permanent ? DeadIntegrationCredentialError : SlackApiError,
      );
    },
  );

  it.each([
    ["HTTP 429", 429, '{"ok":false,"error":"invalid_refresh_token"}'],
    ["HTTP 503", 503, '{"ok":false,"error":"invalid_refresh_token"}'],
    ["malformed JSON", 200, "not json"],
    ["malformed success", 200, '{"ok":true}'],
    ["missing refusal code", 200, '{"ok":false}'],
    ["unexpected envelope", 200, '{"error":"invalid_refresh_token"}'],
  ])(
    "does not classify %s as a dead credential",
    async (_name, status, body) => {
      const { slackProvider } = await import("./provider");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(
          async () =>
            new Response(body, {
              status,
              headers: { "retry-after": "0" },
            }),
        ),
      );
      const error = await slackProvider
        .rotateIntegrationCredential(stored)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(DeadIntegrationCredentialError);
    },
  );

  it("preserves the original connect-timeout error while the access token is live", async () => {
    const { slackProvider } = await import("./provider");
    const timeout = new TypeError("fetch failed", {
      cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout));
    await expect(
      slackProvider.rotateIntegrationCredential(stored),
    ).rejects.toBe(timeout);
  });

  it("classifies a refused rotation after access expiry as dead", async () => {
    const { slackProvider } = await import("./provider");
    const timeout = new TypeError("fetch failed");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout));
    await expect(
      slackProvider.rotateIntegrationCredential(
        JSON.stringify({
          accessToken: "expired-access",
          refreshToken: "old-refresh",
          expiresAt: 1,
        }),
      ),
    ).rejects.toMatchObject({
      name: "DeadIntegrationCredentialError",
      reason: "refused_after_expiry",
      cause: timeout,
    });
  });

  it.each(["not json", '{"accessToken":"incomplete"}'])(
    "classifies unreadable stored credentials as dead without provider calls: %s",
    async (credentials) => {
      const { slackProvider } = await import("./provider");
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(
        slackProvider.rotateIntegrationCredential(credentials),
      ).rejects.toMatchObject({
        name: "DeadIntegrationCredentialError",
        reason: "unreadable",
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("does not rotate a fresh pair unless forced and validates the replacement", async () => {
    const { slackProvider } = await import("./provider");
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          token: "new-access",
          refresh_token: "new-refresh",
          team_id: "T1",
          exp: 123456,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const fresh = JSON.stringify({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    await expect(
      slackProvider.rotateIntegrationCredential(fresh),
    ).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    const rotated = await slackProvider.rotateIntegrationCredential(fresh, {
      force: true,
    });
    expect(rotated?.tenant.externalId).toBe("T1");
    expect(JSON.parse(rotated!.credentialsJson)).toEqual({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: 123456,
    });
  });
});
