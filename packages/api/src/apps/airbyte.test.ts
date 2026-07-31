import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeAirbyteCredentials, normalizeAirbyteBaseUrl } from "./airbyte";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normalizeAirbyteBaseUrl", () => {
  it("derives the self-managed Public API and token URLs", () => {
    expect(
      normalizeAirbyteBaseUrl("https://AIRBYTE.example.com:8443/"),
    ).toEqual({
      apiBaseUrl: "https://airbyte.example.com:8443/api/public/v1",
      tokenUrl: "https://airbyte.example.com:8443/api/v1/applications/token",
      baseAuthority: "airbyte.example.com:8443",
      baseHost: "airbyte.example.com",
      basePath: "/api/public/v1",
    });
  });

  it.each([
    ["not a URL", "valid Airbyte instance URL"],
    ["http://airbyte.example.com", "must use HTTPS"],
    ["https://user:pass@airbyte.example.com", "cannot contain credentials"],
    ["https://airbyte.example.com?x=1", "query parameters"],
    ["https://airbyte.example.com#fragment", "fragment"],
    ["https://airbyte.example.com/proxy", "without a reverse-proxy subpath"],
  ])("rejects unsupported URL %s", (value, expected) => {
    expect(() => normalizeAirbyteBaseUrl(value)).toThrow(expected);
  });
});

describe("exchangeAirbyteCredentials", () => {
  const fields = {
    baseUrl: "https://airbyte.example.com",
    clientId: "client-123",
    clientSecret: "secret-456",
  };

  it("exchanges client credentials and returns endpoint-scoped metadata", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ access_token: "token", expires_in: 120 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchangeAirbyteCredentials(fields);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://airbyte.example.com/api/v1/applications/token");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(JSON.parse(String(init?.body))).toEqual({
      client_id: "client-123",
      client_secret: "secret-456",
      "grant-type": "client_credentials",
    });
    expect(result.credentials).toMatchObject({
      type: "airbyte_client_credentials",
      access_token: "token",
      api_base_url: "https://airbyte.example.com/api/public/v1",
      base_authority: "airbyte.example.com",
      base_host: "airbyte.example.com",
      base_path: "/api/public/v1",
    });
    expect(result.metadata).toEqual({
      name: "airbyte.example.com/api/public/v1",
      apiBaseUrl: "https://airbyte.example.com/api/public/v1",
      baseAuthority: "airbyte.example.com",
      baseHost: "airbyte.example.com",
      basePath: "/api/public/v1",
    });
  });

  it.each([400, 422])(
    "retries status %s with the alternate grant_type field",
    async (status) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ error: "bad field" }, status))
        .mockResolvedValueOnce(jsonResponse({ access_token: "token" }));
      vi.stubGlobal("fetch", fetchMock);

      await exchangeAirbyteCredentials(fields);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
        client_id: "client-123",
        client_secret: "secret-456",
        grant_type: "client_credentials",
      });
    },
  );

  it("does not retry unrelated failures or follow redirects", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: "redirect denied" }, 302));
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeAirbyteCredentials(fields)).rejects.toThrow(
      "Airbyte token exchange failed (302)",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("redacts client credentials from upstream and network errors", async () => {
    const upstreamFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(
          { error_description: "client-123 rejected secret-456" },
          401,
        ),
      );
    vi.stubGlobal("fetch", upstreamFetch);

    await expect(exchangeAirbyteCredentials(fields)).rejects.toThrow(
      "[REDACTED] rejected [REDACTED]",
    );

    const networkFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("request exposed secret-456"));
    vi.stubGlobal("fetch", networkFetch);
    const error = await exchangeAirbyteCredentials(fields).catch(
      (caught: unknown) => caught,
    );
    expect(String(error)).not.toContain("secret-456");
    expect(String(error)).toContain("[REDACTED]");
  });
});
