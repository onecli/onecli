import { describe, expect, it, vi, afterEach } from "vitest";
vi.hoisted(() => {
  process.env.OAUTH_STATE_SECRET = "attio-test-signing-key";
});
import { createHash } from "node:crypto";
import { attio } from "./attio";
import { accessLevelFromState, resolveAccessLevel } from "./access-level";

const method = attio.connectionMethod;
if (method.type !== "oauth") throw new Error("expected an OAuth definition");

const credentials = { clientId: "client-id", clientSecret: "client-secret" };
const redirectUri = "https://api.example.com/v1/apps/attio/callback";

afterEach(() => vi.unstubAllGlobals());

describe("Attio access levels", () => {
  it("defaults to workspace access, the flow existing connections use", () => {
    expect(method.accessLevels?.defaultValue).toBe("workspace");
    expect(method.accessLevels?.options.map((o) => o.value)).toEqual([
      "workspace",
      "user",
    ]);
  });

  it("resolves no request to the default and rejects unknown values", () => {
    expect(resolveAccessLevel(method, undefined)).toEqual({
      ok: true,
      value: "workspace",
    });
    expect(resolveAccessLevel(method, "user")).toEqual({
      ok: true,
      value: "user",
    });
    expect(resolveAccessLevel(method, "admin").ok).toBe(false);
  });

  it("re-validates the level read back from state", () => {
    expect(accessLevelFromState(method, "user")).toBe("user");
    expect(accessLevelFromState(method, "bogus")).toBe("workspace");
    expect(accessLevelFromState(method, undefined)).toBe("workspace");
  });

  it("ignores the level entirely for apps that do not declare any", () => {
    const plain = { ...method, accessLevels: undefined };
    expect(resolveAccessLevel(plain, "user")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(accessLevelFromState(plain, "user")).toBeUndefined();
  });
});

describe("Attio authorize URL", () => {
  it("workspace access sends the original URL: no token_level, no PKCE", async () => {
    const url = new URL(
      await method.buildAuthUrl({
        appCredentials: credentials,
        redirectUri,
        scopes: [],
        state: "s",
        accessLevel: "workspace",
      }),
    );
    expect(url.searchParams.has("token_level")).toBe(false);
    expect(url.searchParams.has("code_challenge")).toBe(false);
  });

  it("personal access requests a user-level token with an S256 challenge", async () => {
    const url = new URL(
      await method.buildAuthUrl({
        appCredentials: credentials,
        redirectUri,
        scopes: [],
        state: "signed-state",
        accessLevel: "user",
      }),
    );
    expect(url.searchParams.get("token_level")).toBe("user");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    // The verifier itself must never appear in the browser-facing URL.
    expect(url.searchParams.has("code_verifier")).toBe(false);
  });
});

describe("Attio code exchange", () => {
  // `/v2/self` reports what Attio actually granted; `null` makes it fail.
  const stubFetch = (self: Record<string, unknown> | null = {}) => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const href = url.toString();
      if (href.endsWith("/oauth/token")) {
        return Response.json({ access_token: "tok", token_type: "Bearer" });
      }
      if (href.endsWith("/v2/self") && self) {
        return Response.json({ active: true, ...self });
      }
      return new Response(null, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  const tokenBody = (fetchMock: ReturnType<typeof stubFetch>) =>
    new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body));

  it("workspace exchange sends no code_verifier", async () => {
    const fetchMock = stubFetch({ token_level: "workspace" });
    const result = await method.exchangeCode({
      appCredentials: credentials,
      callbackParams: { code: "c", state: "s" },
      redirectUri,
    });
    expect(tokenBody(fetchMock).has("code_verifier")).toBe(false);
    expect(result.metadata?.accessLevel).toBe("workspace");
  });

  it("user exchange sends the verifier matching the authorize challenge", async () => {
    const authUrl = new URL(
      await method.buildAuthUrl({
        appCredentials: credentials,
        redirectUri,
        scopes: [],
        state: "signed-state",
        accessLevel: "user",
      }),
    );
    const fetchMock = stubFetch({ token_level: "user" });
    const result = await method.exchangeCode({
      appCredentials: credentials,
      callbackParams: { code: "c", state: "signed-state" },
      redirectUri,
      accessLevel: "user",
    });
    const verifier = tokenBody(fetchMock).get("code_verifier");
    expect(verifier).toBeTruthy();
    expect(createHash("sha256").update(verifier!).digest("base64url")).toBe(
      authUrl.searchParams.get("code_challenge"),
    );
    expect(result.metadata?.accessLevel).toBe("user");
  });

  // A personal token holds only the scopes the installing admin approved, so
  // the connection records Attio's answer, not the app's full scope list.
  it("records the level and scopes Attio granted, not the ones requested", async () => {
    stubFetch({
      token_level: "workspace",
      scope: "note:read-write  task:read-write",
    });
    const result = await method.exchangeCode({
      appCredentials: credentials,
      callbackParams: { code: "c", state: "signed-state" },
      redirectUri,
      accessLevel: "user",
    });
    expect(result.metadata?.accessLevel).toBe("workspace");
    expect(result.scopes).toEqual(["note:read-write", "task:read-write"]);
  });

  it("falls back to the requested level and the app's scopes when /v2/self fails", async () => {
    stubFetch(null);
    const result = await method.exchangeCode({
      appCredentials: credentials,
      callbackParams: { code: "c", state: "signed-state" },
      redirectUri,
      accessLevel: "user",
    });
    expect(result.metadata).toEqual({ accessLevel: "user" });
    expect(result.scopes).toEqual(method.permissions?.map((p) => p.scope));
  });

  it("ignores a level or scope of an unexpected shape from /v2/self", async () => {
    stubFetch({ token_level: "admin", scope: ["note:read-write"] });
    const result = await method.exchangeCode({
      appCredentials: credentials,
      callbackParams: { code: "c", state: "s" },
      redirectUri,
    });
    expect(result.metadata?.accessLevel).toBe("workspace");
    expect(result.scopes).toEqual(method.permissions?.map((p) => p.scope));
  });

  it("refuses a callback without a code before calling Attio", async () => {
    const fetchMock = stubFetch();
    await expect(
      method.exchangeCode({
        appCredentials: credentials,
        callbackParams: { state: "s" },
        redirectUri,
      }),
    ).rejects.toThrow(/missing authorization code/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces Attio's own error instead of exchanging a missing code", async () => {
    const fetchMock = stubFetch();
    await expect(
      method.exchangeCode({
        appCredentials: credentials,
        callbackParams: {
          error: "access_denied",
          error_description: "This app does not support personal access",
        },
        redirectUri,
        accessLevel: "user",
      }),
    ).rejects.toThrow(/does not support personal access/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
