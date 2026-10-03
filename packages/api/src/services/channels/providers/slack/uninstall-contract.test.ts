import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});
const credentialsJson = JSON.stringify({
  botToken: "xoxb-secret-canary",
  clientId: "client",
  clientSecret: "secret-canary",
});
afterEach(() => vi.unstubAllGlobals());

describe("observable Slack uninstall", () => {
  it("confirms only a successful upstream uninstall", async () => {
    const { slackProvider } = await import("./provider");
    const fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
    vi.stubGlobal("fetch", fetch);
    expect(
      await slackProvider.uninstallRemotePresence!({ credentialsJson }),
    ).toEqual({ outcome: "uninstalled" });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    null,
    "bad json",
    "{}",
    '{"botToken":"xoxb-secret-canary"}',
    '{"clientId":"id","clientSecret":"secret"}',
  ])(
    "retains missing or malformed credential %s as blocked",
    async (credentialsJson) => {
      const { slackProvider } = await import("./provider");
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      expect(
        await slackProvider.uninstallRemotePresence!({ credentialsJson }),
      ).toMatchObject({ outcome: "blocked" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    "account_inactive",
    "token_revoked",
    "invalid_auth",
    "invalid_client_id",
    "bad_client_secret",
  ])("does not mistake %s for confirmed uninstall", async (error) => {
    const { slackProvider } = await import("./provider");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ ok: false, error }))),
    );
    expect(
      await slackProvider.uninstallRemotePresence!({ credentialsJson }),
    ).toEqual({
      outcome: "blocked",
      reason: "uninstall_authorization_required",
    });
  });
  it.each([
    [200, '{"ok":false,"error":"secret-canary"}'],
    [200, "secret-canary"],
    [503, "secret-canary"],
    [429, "secret-canary"],
  ])(
    "retains HTTP %s retry without leaking response secrets",
    async (status, body) => {
      const { slackProvider } = await import("./provider");
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockImplementation(
            async () =>
              new Response(body, { status, headers: { "retry-after": "0" } }),
          ),
      );
      expect(
        await slackProvider.uninstallRemotePresence!({ credentialsJson }),
      ).toEqual({ outcome: "retry", reason: "uninstall_unavailable" });
    },
  );
  it("retains network failures without leaking credentials", async () => {
    const { slackProvider } = await import("./provider");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("secret-canary")),
    );
    expect(
      await slackProvider.uninstallRemotePresence!({ credentialsJson }),
    ).toEqual({ outcome: "retry", reason: "uninstall_unavailable" });
  });
  it("best-effort rename exports and updates the manifest with the config token alone", async () => {
    const { slackProvider } = await import("./provider");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            manifest: {
              display_information: { name: "before" },
              features: { bot_user: { display_name: "before" } },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response('{"ok":true}'));
    vi.stubGlobal("fetch", fetch);
    await slackProvider.renameRemotePresence!({
      accessToken: "config",
      externalId: "A1",
    });
    // Two calls and done: no propagation poll, no presence credential read.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("apps.manifest.export");
    expect(String(fetch.mock.calls[1]?.[0])).toContain("apps.manifest.update");
  });
});

describe("idempotent Slack app-record deletion", () => {
  it("treats an already-deleted app as done (a replayed manifest phase)", async () => {
    const { slackProvider } = await import("./provider");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"ok":false,"error":"app_not_found"}'),
        ),
    );
    await expect(
      slackProvider.deleteRemotePresence({
        accessToken: "config",
        externalId: "A1",
      }),
    ).resolves.toBeUndefined();
  });
  it("still surfaces every other refusal so the job is retained", async () => {
    const { slackProvider } = await import("./provider");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response('{"ok":false,"error":"invalid_auth"}')),
    );
    await expect(
      slackProvider.deleteRemotePresence({
        accessToken: "config",
        externalId: "A1",
      }),
    ).rejects.toMatchObject({ code: "invalid_auth" });
  });
});
