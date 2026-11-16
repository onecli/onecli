import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vertexAi } from "./vertex-ai";

const method = vertexAi.connectionMethod;
if (method.type !== "credentials_import") {
  throw new Error("expected credentials_import");
}
const exchange = method.exchangeCredentials;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const NOW_S = Date.parse("2026-11-07T00:00:00Z") / 1000;

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const serviceAccount = {
  privateKey,
  clientEmail: "sa@proj.iam.gserviceaccount.com",
  projectId: "proj-1",
};
const authorizedUser = {
  refreshToken: "1//refresh",
  clientId: "client-1.apps.googleusercontent.com",
  clientSecret: "GOCSPX-secret",
  quotaProjectId: "quota-1",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Answers the token endpoint with `token` and userinfo with `user`. */
const stubFetch = (
  token: () => Response,
  user: () => Response = () => json({}),
) => {
  const fetchMock = vi.fn<typeof fetch>(async (input) =>
    String(input) === TOKEN_URL ? token() : user(),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const tokenRequest = (fetchMock: ReturnType<typeof stubFetch>) => {
  const [url, init] = fetchMock.mock.calls[0]!;
  return {
    url: String(url),
    method: init?.method,
    headers: init?.headers,
    params: [...(init?.body as URLSearchParams).entries()],
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_S * 1000);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Vertex AI credentials import", () => {
  describe("service account", () => {
    it("exchanges a signed JWT assertion for an access token", async () => {
      const fetchMock = stubFetch(() =>
        json({ access_token: "ya29.sa", expires_in: 3599 }),
      );

      const result = await exchange(serviceAccount);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const req = tokenRequest(fetchMock);
      expect(req.url).toBe(TOKEN_URL);
      expect(req.method).toBe("POST");
      expect(req.headers).toEqual({
        "Content-Type": "application/x-www-form-urlencoded",
      });
      expect(req.params.map(([k]) => k)).toEqual(["grant_type", "assertion"]);
      expect(req.params[0]![1]).toBe(
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      );

      const [header, claims, signature] = req.params[1]![1].split(".");
      expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
        alg: "RS256",
        typ: "JWT",
      });
      expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
        iss: serviceAccount.clientEmail,
        sub: serviceAccount.clientEmail,
        aud: TOKEN_URL,
        scope: SCOPE,
        iat: NOW_S,
        exp: NOW_S + 3600,
      });
      const verify = createVerify("RSA-SHA256");
      verify.update(`${header}.${claims}`);
      expect(verify.verify(publicKey, signature!, "base64url")).toBe(true);

      expect(result).toEqual({
        credentials: {
          type: "service_account",
          access_token: "ya29.sa",
          private_key: privateKey,
          client_email: serviceAccount.clientEmail,
          project_id: serviceAccount.projectId,
          expires_at: NOW_S + 3599,
        },
        scopes: [SCOPE],
        metadata: {
          quotaProjectId: serviceAccount.projectId,
          username: serviceAccount.clientEmail,
        },
      });
    });

    it("leaves expires_at undefined when Google omits expires_in", async () => {
      stubFetch(() => json({ access_token: "ya29.sa" }));
      const result = await exchange(serviceAccount);
      expect(result.credentials).toHaveProperty("expires_at", undefined);
    });

    it("requires a project ID before calling Google", async () => {
      const fetchMock = stubFetch(() => json({}));
      await expect(
        exchange({ ...serviceAccount, projectId: "" }),
      ).rejects.toThrow("GCP Project ID is required");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("surfaces Google's error_description on an HTTP error", async () => {
      stubFetch(() =>
        json({ error: "invalid_grant", error_description: "Invalid JWT" }, 400),
      );
      await expect(exchange(serviceAccount)).rejects.toThrow(
        new Error("Invalid JWT"),
      );
    });

    it("falls back to the status when the error body is not JSON", async () => {
      stubFetch(() => new Response("upstream down", { status: 503 }));
      await expect(exchange(serviceAccount)).rejects.toThrow(
        new Error("Service account token exchange failed: 503"),
      );
    });

    it.each([
      [
        { error: "x", error_description: "denied", access_token: "t" },
        "denied",
      ],
      [{ error: "x" }, "Failed to obtain access token"],
      [{}, "Failed to obtain access token"],
      [{ error_description: "no token" }, "no token"],
    ])("rejects a 200 without a usable token: %j", async (body, message) => {
      stubFetch(() => json(body));
      await expect(exchange(serviceAccount)).rejects.toThrow(
        new Error(message),
      );
    });
  });

  describe("authorized user", () => {
    it("refreshes the token and reads the Google profile", async () => {
      const fetchMock = stubFetch(
        () => json({ access_token: "ya29.user", expires_in: 3600 }),
        () =>
          json({
            email: "dev@example.com",
            name: "Dev",
            picture: "https://img/dev.png",
          }),
      );

      const result = await exchange(authorizedUser);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const req = tokenRequest(fetchMock);
      expect(req.url).toBe(TOKEN_URL);
      expect(req.method).toBe("POST");
      expect(req.headers).toEqual({
        "Content-Type": "application/x-www-form-urlencoded",
      });
      expect(req.params).toEqual([
        ["client_id", authorizedUser.clientId],
        ["client_secret", authorizedUser.clientSecret],
        ["refresh_token", authorizedUser.refreshToken],
        ["grant_type", "refresh_token"],
      ]);
      const [userUrl, userInit] = fetchMock.mock.calls[1]!;
      expect(String(userUrl)).toBe(USERINFO_URL);
      expect(userInit).toEqual({
        headers: { Authorization: "Bearer ya29.user" },
      });

      expect(result).toEqual({
        credentials: {
          access_token: "ya29.user",
          refresh_token: authorizedUser.refreshToken,
          token_type: "Bearer",
          expires_at: NOW_S + 3600,
        },
        scopes: [SCOPE],
        metadata: {
          quotaProjectId: authorizedUser.quotaProjectId,
          username: "dev@example.com",
          name: "Dev",
          avatarUrl: "https://img/dev.png",
        },
      });
    });

    it("keeps only the quota project when the profile lookup fails", async () => {
      stubFetch(
        () => json({ access_token: "ya29.user" }),
        () => json({ error: "forbidden" }, 403),
      );
      const result = await exchange(authorizedUser);
      expect(result.metadata).toEqual({
        quotaProjectId: authorizedUser.quotaProjectId,
      });
      expect(result.credentials).toHaveProperty("expires_at", undefined);
    });

    it.each(["refreshToken", "clientId", "clientSecret"] as const)(
      "requires %s before calling Google",
      async (field) => {
        const fetchMock = stubFetch(() => json({}));
        await expect(
          exchange({ ...authorizedUser, [field]: "" }),
        ).rejects.toThrow(
          "Refresh token, client ID, and client secret are required",
        );
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it("surfaces Google's error_description on an HTTP error", async () => {
      stubFetch(() =>
        json(
          {
            error: "invalid_grant",
            error_description: "Token has been expired",
          },
          400,
        ),
      );
      await expect(exchange(authorizedUser)).rejects.toThrow(
        new Error("Token has been expired"),
      );
    });

    it("falls back to the status when the error body is not JSON", async () => {
      stubFetch(() => new Response("upstream down", { status: 502 }));
      await expect(exchange(authorizedUser)).rejects.toThrow(
        new Error("Token refresh failed: 502"),
      );
    });

    it.each([
      [
        { error: "x", error_description: "denied", access_token: "t" },
        "denied",
      ],
      [{ error: "x" }, "Failed to obtain access token"],
      [{}, "Failed to obtain access token"],
    ])("rejects a 200 without a usable token: %j", async (body, message) => {
      const fetchMock = stubFetch(() => json(body));
      await expect(exchange(authorizedUser)).rejects.toThrow(
        new Error(message),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it("uses the service-account flow only when both key and email are set", async () => {
    const fetchMock = stubFetch(() => json({ access_token: "t" }));
    await exchange({ ...authorizedUser, privateKey, clientEmail: "" });
    expect(tokenRequest(fetchMock).params[0]).toEqual([
      "client_id",
      authorizedUser.clientId,
    ]);
  });
});
