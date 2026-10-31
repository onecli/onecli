import { afterEach, describe, expect, it, vi } from "vitest";
import { docker } from "./docker";

const method = docker.connectionMethod;
if (method.type !== "credentials_import") {
  throw new Error("docker must be a credentials_import app");
}
const { exchangeCredentials } = method;

// A JWT whose payload is {"exp":4102444800}.
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDB9.c2ln";

const stubFetch = (body: unknown, status = 200) => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("docker hub connect", () => {
  it("mints through Create access token, not the deprecated login route", async () => {
    const fetchMock = stubFetch({ access_token: JWT });

    const result = await exchangeCredentials({
      username: "octo",
      apiToken: "dckr_pat_x",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hub.docker.com/v2/auth/token");
    expect(JSON.parse(String(init.body))).toEqual({
      identifier: "octo",
      secret: "dckr_pat_x",
    });
    // The shape the gateway re-mints from: `password` holds the PAT.
    expect(result.credentials).toEqual({
      type: "docker_hub",
      access_token: JWT,
      username: "octo",
      password: "dckr_pat_x",
      expires_at: 4_102_444_800 - 60,
    });
    expect(result.metadata).toEqual({ username: "octo", name: "octo" });
  });

  it("names the fix for a refused token instead of Docker's bare message", async () => {
    stubFetch({ errinfo: null, message: "unauthorized" }, 401);
    await expect(
      exchangeCredentials({ username: "octo", apiToken: "revoked" }),
    ).rejects.toThrow(/rejected this username and Personal Access Token/);
  });

  it("reports any other failure by its status", async () => {
    stubFetch({ message: "slow down" }, 429);
    await expect(
      exchangeCredentials({ username: "octo", apiToken: "dckr_pat_x" }),
    ).rejects.toThrow("Docker Hub token request failed (429)");
  });
});
