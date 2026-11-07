import { afterEach, describe, expect, it, vi } from "vitest";
import { zendesk, zendeskHost } from "./zendesk";

const method = zendesk.connectionMethod;
if (method.type !== "oauth") throw new Error("expected OAuth");
const REDIRECT = "https://api.example.com/v1/apps/zendesk/callback";
const creds = {
  subdomain: "acme",
  clientId: "client-1",
  clientSecret: "secret-1",
};
const grant = { access_token: "tok-1", refresh_token: "ref-1" };
const exchange = (
  appCredentials = creds,
  callbackParams: Record<string, string> = { code: "code-1" },
) =>
  method.exchangeCode({
    appCredentials,
    callbackParams,
    redirectUri: REDIRECT,
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("zendeskHost", () => {
  it.each(["acme", " ACME.zendesk.com ", "https://acme.zendesk.com/"])(
    "accepts %s",
    (value) => {
      expect(zendeskHost(value)).toBe("acme.zendesk.com");
    },
  );
  it.each([
    undefined,
    null,
    123,
    {},
    [],
    "",
    "evil.com",
    "a.b",
    "-acme",
    "acme-",
    "a".repeat(64),
    "https://acme.zendesk.com@evil.com",
    "https://acme.zendesk.com:443",
    "https://acme.zendesk.com/path",
    "https://acme.zendesk.com?x",
    "http://acme.zendesk.com",
    "acme.zendesk.com.evil",
    "acme\\evil",
  ])("rejects %j", (value) => {
    expect(() => zendeskHost(value)).toThrow("Invalid Zendesk subdomain");
  });
});

describe("Zendesk OAuth", () => {
  it("builds the account authorization URL", async () => {
    const url = new URL(
      await method.buildAuthUrl({
        appCredentials: creds,
        redirectUri: REDIRECT,
        scopes: method.defaultScopes ?? [],
        state: "state-1",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://acme.zendesk.com/oauth/authorizations/new",
    );
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("client_id")).toBe("client-1");
  });
  it.each([
    { ...creds, clientId: "" },
    { ...creds, clientSecret: "" },
    { ...creds, subdomain: "evil.com" },
    { ...creds, subdomain: "https://acme.zendesk.com@evil.com" },
  ])("rejects invalid configuration without fetch: %j", async (credentials) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    await expect(exchange(credentials)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects missing client ID on authorization", async () => {
    expect(() =>
      method.buildAuthUrl({
        appCredentials: { ...creds, clientId: "" },
        redirectUri: REDIRECT,
        scopes: [],
        state: "s",
      }),
    ).toThrow();
  });
  it("rejects missing code and sanitizes callback errors without fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    await expect(exchange(creds, {})).rejects.toThrow(
      /missing authorization code/,
    );
    await expect(
      exchange(creds, {
        error: "secret-provider-text",
        error_description: "sensitive",
      }),
    ).rejects.toThrow("Zendesk authorization failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("sanitizes HTTP token errors", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response("sensitive", { status: 401, statusText: "secret" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(exchange()).rejects.toThrow(
      "Zendesk token exchange failed: 401",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([
    null,
    [],
    {},
    { ...grant, access_token: " " },
    { ...grant, access_token: 7 },
    { ...grant, refresh_token: " " },
    { ...grant, refresh_token: null },
    ...[null, "1800", 0, -1, 1.5, 172801, Number.MAX_SAFE_INTEGER, 1e100].map(
      (expires_in) => ({
        ...grant,
        expires_in,
      }),
    ),
    { ...grant, token_type: "Basic" },
    { ...grant, token_type: 1 },
    { ...grant, scope: [] },
  ])(
    "rejects malformed token payload %j before identity fetch",
    async (payload) => {
      const fetchMock = vi.fn<typeof fetch>(async () => Response.json(payload));
      vi.stubGlobal("fetch", fetchMock);
      await expect(exchange()).rejects.toThrow(
        /Invalid Zendesk token response/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects redirects on both credential-bearing requests and accepts the lifetime boundary", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/oauth/tokens")
        ? Response.json({ ...grant, expires_in: 172800 })
        : Response.json({ user: { name: "A" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const before = Math.floor(Date.now() / 1000);
    const result = await exchange();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(fetchMock.mock.calls[1]?.[1]?.redirect).toBe("error");
    expect(result.credentials.expires_at).toBeGreaterThanOrEqual(
      before + 172800,
    );
    expect(result.credentials.expires_at).toBeLessThanOrEqual(
      Math.floor(Date.now() / 1000) + 172800,
    );
  });

  it("rejects invalid token JSON with a sanitized error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("invalid JSON")),
    );
    await expect(exchange()).rejects.toThrow(/Invalid Zendesk token response/);
  });
  it.each(["Bearer", "bearer", "BEARER"])(
    "accepts %s and defaults only absent expiry to 1800 seconds",
    async (token_type) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-28T00:00:00Z"));
      const fetchMock = vi.fn<typeof fetch>(async (input) =>
        String(input).endsWith("/oauth/tokens")
          ? Response.json({
              access_token: " tok-1 ",
              refresh_token: " ref-1 ",
              token_type,
              scope: "read write",
            })
          : Response.json({
              user: { email: "a@acme.com", name: "A", photo: null },
            }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const result = await exchange();
      expect(result.credentials).toEqual({
        ...grant,
        token_type: "Bearer",
        expires_at: Math.floor(Date.now() / 1000) + 1800,
        instance_host: "acme.zendesk.com",
      });
      expect(result.scopes).toEqual(["read", "write"]);
      expect(result.metadata).toMatchObject({
        instance: "acme.zendesk.com",
        username: "a@acme.com",
      });
      expect(
        JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
      ).toMatchObject({
        scope: method.defaultScopes?.join(" "),
        expires_in: 1800,
        refresh_token_expires_in: 2592000,
        code: "code-1",
        redirect_uri: REDIRECT,
      });
    },
  );
  it.each(["network", "http", "json", "shape", "null"])(
    "preserves the grant and host when optional identity fails: %s",
    async (failure) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input) => {
          if (String(input).endsWith("/oauth/tokens"))
            return Response.json({ ...grant, expires_in: 60 });
          if (failure === "network") throw new Error("offline");
          if (failure === "http") return new Response("error", { status: 500 });
          if (failure === "json") return new Response("not JSON");
          return Response.json(
            failure === "null" ? null : { user: { email: 123, photo: "bad" } },
          );
        }),
      );
      const before = Math.floor(Date.now() / 1000);
      const result = await exchange();
      expect(result.credentials).toMatchObject({
        ...grant,
        instance_host: "acme.zendesk.com",
      });
      expect(result.credentials.expires_at).toBeGreaterThanOrEqual(before + 60);
      expect(result.credentials.expires_at).toBeLessThanOrEqual(
        Math.floor(Date.now() / 1000) + 60,
      );
      expect(result.metadata).toEqual({ instance: "acme.zendesk.com" });
      expect(result.scopes).toEqual([]);
    },
  );
});
