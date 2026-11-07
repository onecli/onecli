import { afterEach, describe, expect, it, vi } from "vitest";
import { webflow } from "./webflow";

const method = webflow.connectionMethod;
if (method.type !== "oauth") throw new Error("expected an OAuth definition");

const REDIRECT = "https://api.example.com/v1/apps/webflow/callback";
const creds = { clientId: "client-1", clientSecret: "secret-1" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webflow OAuth authorize URL", () => {
  it("builds a standard authorization-code request", async () => {
    const url = new URL(
      await method.buildAuthUrl({
        appCredentials: creds,
        redirectUri: REDIRECT,
        scopes: ["sites:read", "cms:write"],
        state: "state-1",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://webflow.com/oauth/authorize",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    // Webflow wants space-separated scopes.
    expect(url.searchParams.get("scope")).toBe("sites:read cms:write");
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  it("refuses to build a URL without a client ID", () => {
    expect(() =>
      method.buildAuthUrl({
        appCredentials: {},
        redirectUri: REDIRECT,
        scopes: [],
        state: "s",
      }),
    ).toThrow(/client ID/);
  });

  // Webflow fails authorization if the URL asks for any scope the app was
  // not configured with, so the requested set must stay inside it.
  it("only requests scopes ticked on the Webflow app", () => {
    const configured = new Set([
      "assets:read",
      "assets:write",
      "authorized_user:read",
      "cms:read",
      "cms:write",
      "comments:read",
      "components:read",
      "components:write",
      "forms:read",
      "forms:write",
      "pages:read",
      "pages:write",
      "site_activity:read",
      "site_config:read",
      "site_config:write",
      "sites:read",
      "sites:write",
    ]);
    for (const scope of method.defaultScopes ?? []) {
      expect(configured.has(scope), scope).toBe(true);
    }
  });
});

describe("webflow code exchange", () => {
  it("exchanges the code with the redirect URI and records the user", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://api.webflow.com/oauth/access_token") {
        return Response.json({
          access_token: "tok-1",
          token_type: "bearer",
          scope: "sites:read cms:read",
        });
      }
      if (url === "https://api.webflow.com/v2/token/authorized_by") {
        return Response.json({
          id: "u-1",
          email: "a@example.com",
          firstName: "Ada",
          lastName: "Lovelace",
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await method.exchangeCode({
      appCredentials: creds,
      callbackParams: { code: "code-1" },
      redirectUri: REDIRECT,
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("client_id")).toBe("client-1");
    expect(body.get("client_secret")).toBe("secret-1");
    expect(body.get("code")).toBe("code-1");
    expect(body.get("grant_type")).toBe("authorization_code");
    // Sent on authorize, so Webflow requires it here too.
    expect(body.get("redirect_uri")).toBe(REDIRECT);

    expect(result.credentials).toEqual({
      access_token: "tok-1",
      token_type: "bearer",
    });
    expect(result.scopes).toEqual(["sites:read", "cms:read"]);
    expect(result.metadata).toMatchObject({
      email: "a@example.com",
      name: "Ada Lovelace",
    });
  });

  it("still connects when the user lookup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/oauth/access_token")
          ? Response.json({ access_token: "tok-1" })
          : new Response("nope", { status: 403 }),
      ),
    );
    const result = await method.exchangeCode({
      appCredentials: creds,
      callbackParams: { code: "code-1" },
      redirectUri: REDIRECT,
    });
    expect(result.credentials.access_token).toBe("tok-1");
    expect(result.metadata).toEqual({});
  });

  it("surfaces a denied authorization", async () => {
    await expect(
      method.exchangeCode({
        appCredentials: creds,
        callbackParams: { error: "access_denied" },
        redirectUri: REDIRECT,
      }),
    ).rejects.toThrow(/access_denied/);
  });

  it("does not leak the response body of a failed token exchange", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("secret-ish body", { status: 400 })),
    );
    await expect(
      method.exchangeCode({
        appCredentials: creds,
        callbackParams: { code: "bad" },
        redirectUri: REDIRECT,
      }),
    ).rejects.toThrow(/^Webflow token exchange failed: 400/);
  });
});
