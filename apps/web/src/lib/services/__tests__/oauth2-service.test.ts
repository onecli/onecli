import { describe, it, expect, vi, beforeAll } from "vitest";
import { generateKeyPairSync, createVerify } from "crypto";
import {
  createGoogleJWT,
  fetchGoogleAccessToken,
  fetchGenericAccessToken,
  GOOGLE_TOKEN_ENDPOINT,
  type GoogleServiceAccountKey,
} from "../oauth2-service";
import { parseOAuth2Metadata } from "@/lib/validations/secret";

// ── Test fixtures (generated fresh each run) ───────────────────────────

let TEST_PRIVATE_KEY: string;
let TEST_SERVICE_ACCOUNT: GoogleServiceAccountKey;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  TEST_PRIVATE_KEY = privateKey;
  TEST_SERVICE_ACCOUNT = {
    type: "service_account",
    project_id: "test-project-123",
    private_key_id: "key-id-abc",
    private_key: TEST_PRIVATE_KEY,
    client_email: "test@test-project-123.iam.gserviceaccount.com",
    token_uri: "https://oauth2.googleapis.com/token",
  };
});

// ── createGoogleJWT ────────────────────────────────────────────────────

describe("createGoogleJWT", () => {
  it("produces a valid 3-part JWT", () => {
    const jwt = createGoogleJWT(
      TEST_SERVICE_ACCOUNT,
      ["https://www.googleapis.com/auth/cloud-platform"],
      1000000,
    );
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
  });

  it("sets correct header", () => {
    const jwt = createGoogleJWT(TEST_SERVICE_ACCOUNT, ["scope1"], 1000000);
    const header = JSON.parse(
      Buffer.from(jwt.split(".")[0]!, "base64url").toString(),
    );
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("sets correct payload fields", () => {
    const now = 1700000000;
    const jwt = createGoogleJWT(
      TEST_SERVICE_ACCOUNT,
      ["scope-a", "scope-b"],
      now,
    );
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1]!, "base64url").toString(),
    );

    expect(payload.iss).toBe(TEST_SERVICE_ACCOUNT.client_email);
    expect(payload.scope).toBe("scope-a scope-b");
    expect(payload.aud).toBe(TEST_SERVICE_ACCOUNT.token_uri);
    expect(payload.iat).toBe(now);
    expect(payload.exp).toBe(now + 3600);
  });

  it("uses default token endpoint when token_uri is empty", () => {
    const sa = { ...TEST_SERVICE_ACCOUNT, token_uri: "" };
    const jwt = createGoogleJWT(sa, ["scope1"], 1000000);
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1]!, "base64url").toString(),
    );
    expect(payload.aud).toBe(GOOGLE_TOKEN_ENDPOINT);
  });

  it("signature is verifiable with the private key", () => {
    const jwt = createGoogleJWT(TEST_SERVICE_ACCOUNT, ["scope1"], 1000000);
    const [headerB64, payloadB64, signatureB64] = jwt.split(".");
    const unsigned = `${headerB64}.${payloadB64}`;
    const signature = Buffer.from(signatureB64!, "base64url");

    const verifier = createVerify("RSA-SHA256");
    verifier.update(unsigned);
    const isValid = verifier.verify(TEST_PRIVATE_KEY, signature);
    expect(isValid).toBe(true);
  });

  it("different timestamps produce different JWTs", () => {
    const jwt1 = createGoogleJWT(TEST_SERVICE_ACCOUNT, ["s"], 1000000);
    const jwt2 = createGoogleJWT(TEST_SERVICE_ACCOUNT, ["s"], 2000000);
    expect(jwt1).not.toBe(jwt2);
  });
});

// ── fetchGoogleAccessToken ─────────────────────────────────────────────

describe("fetchGoogleAccessToken", () => {
  it("sends JWT to token endpoint and returns access token", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "ya29.test-token",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    });

    const result = await fetchGoogleAccessToken(
      TEST_SERVICE_ACCOUNT,
      ["https://www.googleapis.com/auth/cloud-platform"],
      mockFetch,
    );

    expect(result.accessToken).toBe("ya29.test-token");
    expect(result.expiresInSecs).toBe(3600);

    // Verify fetch was called with correct URL and method
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe(TEST_SERVICE_ACCOUNT.token_uri);
    expect(opts.method).toBe("POST");

    // Verify body contains the JWT assertion
    const body = opts.body as URLSearchParams;
    expect(body.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    expect(body.get("assertion")).toMatch(
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );
  });

  it("throws on non-OK response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "invalid_grant",
    });

    await expect(
      fetchGoogleAccessToken(TEST_SERVICE_ACCOUNT, ["scope"], mockFetch),
    ).rejects.toThrow("Google token exchange failed (401): invalid_grant");
  });

  it("uses custom token_uri from service account", async () => {
    const sa = {
      ...TEST_SERVICE_ACCOUNT,
      token_uri: "https://custom.endpoint/token",
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "tok",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    });

    await fetchGoogleAccessToken(sa, ["scope"], mockFetch);
    expect(mockFetch.mock.calls[0]![0]).toBe("https://custom.endpoint/token");
  });
});

// ── fetchGenericAccessToken ────────────────────────────────────────────

describe("fetchGenericAccessToken", () => {
  it("sends refresh_token grant and returns access token", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-access-token",
        expires_in: 7200,
      }),
    });

    const result = await fetchGenericAccessToken(
      "my-refresh-token",
      "https://auth.example.com/token",
      undefined,
      undefined,
      mockFetch,
    );

    expect(result.accessToken).toBe("new-access-token");
    expect(result.expiresInSecs).toBe(7200);

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://auth.example.com/token");

    const body = opts.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("my-refresh-token");
    expect(body.has("client_id")).toBe(false);
  });

  it("includes client_id and client_secret when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "tok", expires_in: 3600 }),
    });

    await fetchGenericAccessToken(
      "refresh-tok",
      "https://auth.example.com/token",
      "my-client-id",
      "my-client-secret",
      mockFetch,
    );

    const body = mockFetch.mock.calls[0]![1].body as URLSearchParams;
    expect(body.get("client_id")).toBe("my-client-id");
    expect(body.get("client_secret")).toBe("my-client-secret");
  });

  it("throws on non-OK response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error": "invalid_grant"}',
    });

    await expect(
      fetchGenericAccessToken(
        "bad-token",
        "https://auth.example.com/token",
        undefined,
        undefined,
        mockFetch,
      ),
    ).rejects.toThrow('Token refresh failed (400): {"error": "invalid_grant"}');
  });

  it("defaults to 3600 when expires_in is missing", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "tok" }),
    });

    const result = await fetchGenericAccessToken(
      "refresh-tok",
      "https://auth.example.com/token",
      undefined,
      undefined,
      mockFetch,
    );

    expect(result.expiresInSecs).toBe(3600);
  });
});

// ── parseOAuth2Metadata ────────────────────────────────────────────────

describe("parseOAuth2Metadata", () => {
  it("parses valid google metadata", () => {
    const result = parseOAuth2Metadata({
      provider: "google",
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      refreshIntervalSecs: 2700,
    });
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("google");
    expect(result!.scopes).toEqual([
      "https://www.googleapis.com/auth/cloud-platform",
    ]);
  });

  it("parses valid generic metadata", () => {
    const result = parseOAuth2Metadata({
      provider: "generic",
      tokenEndpoint: "https://auth.example.com/token",
      refreshIntervalSecs: 1800,
    });
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("generic");
    expect(result!.tokenEndpoint).toBe("https://auth.example.com/token");
  });

  it("returns null for missing provider", () => {
    expect(parseOAuth2Metadata({ scopes: [] })).toBeNull();
  });

  it("returns null for invalid provider", () => {
    expect(parseOAuth2Metadata({ provider: "azure" })).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseOAuth2Metadata(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseOAuth2Metadata(undefined)).toBeNull();
  });
});
