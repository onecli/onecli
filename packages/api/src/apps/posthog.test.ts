import { afterEach, describe, expect, it, vi } from "vitest";
import { posthog } from "./posthog";

const resolveMetadata =
  posthog.connectionMethod.type === "api_key"
    ? posthog.connectionMethod.resolveMetadata
    : undefined;

if (!resolveMetadata) throw new Error("posthog must expose resolveMetadata");

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const ME_URL = {
  us: "https://us.posthog.com/api/users/@me/",
  eu: "https://eu.posthog.com/api/users/@me/",
} as const;

/** Route a fetch by host: `us` and `eu` each get their own response. */
const byRegion = (
  us: ReturnType<typeof jsonResponse> | Error,
  eu: ReturnType<typeof jsonResponse> | Error,
) =>
  vi.fn(async (url: string) => {
    const res = url.startsWith("https://us.") ? us : eu;
    if (res instanceof Error) throw res;
    return res;
  });

describe("posthog key-shape validation", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Project API keys (phc_) are public write-only tokens for event capture;
  // they cannot read anything the catalog offers, so refuse them up front
  // rather than let the region probe report a confusing 401.
  it("rejects a project API key without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolveMetadata({ apiKey: "phc_abc" })).rejects.toThrow(
      /phx_/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a value that isn't a PostHog key at all", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(resolveMetadata({ apiKey: "hunter2" })).rejects.toThrow(
      /doesn't look like a PostHog personal API key/,
    );
  });
});

describe("posthog region detection", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Personal API keys authenticate with a plain Bearer header
  // (posthog.com/docs/api/personal-api-keys).
  it("sends the trimmed key as a Bearer token", async () => {
    const fetchMock = byRegion(jsonResponse(200, {}), jsonResponse(401, {}));
    vi.stubGlobal("fetch", fetchMock);
    await resolveMetadata({ apiKey: " phx_key \n" });
    expect(fetchMock).toHaveBeenCalledWith(ME_URL.us, {
      headers: { Authorization: "Bearer phx_key" },
    });
  });

  it("resolves a US key and records the region", async () => {
    vi.stubGlobal(
      "fetch",
      byRegion(
        jsonResponse(200, {
          email: "jane@example.com",
          first_name: "Jane",
          last_name: "Doe",
          organization: { id: "org1", name: "Acme" },
          team: { id: 42, name: "Web" },
        }),
        jsonResponse(401, {}),
      ),
    );
    await expect(resolveMetadata({ apiKey: "phx_us" })).resolves.toEqual({
      username: "jane@example.com",
      email: "jane@example.com",
      name: "Jane Doe",
      organizationName: "Acme",
      organizationId: "org1",
      projectName: "Web",
      projectId: 42,
      region: "us",
    });
  });

  // A key lives in exactly one region, so the US host answers 401 for an EU
  // key. That 401 must not be mistaken for a bad key.
  it("falls through to EU when US rejects the key", async () => {
    vi.stubGlobal(
      "fetch",
      byRegion(
        jsonResponse(401, {}),
        jsonResponse(200, { email: "eu@example.com" }),
      ),
    );
    await expect(resolveMetadata({ apiKey: "phx_eu" })).resolves.toMatchObject({
      email: "eu@example.com",
      region: "eu",
    });
  });

  it("hard-fails only when BOTH regions reject the key", async () => {
    vi.stubGlobal(
      "fetch",
      byRegion(jsonResponse(401, {}), jsonResponse(401, {})),
    );
    await expect(resolveMetadata({ apiKey: "phx_bad" })).rejects.toThrow(
      /both the US and EU regions/,
    );
  });

  // 403 = the key is valid but lacks `user:read`. That is a legitimately
  // narrow key, so keep it and remember which region answered.
  it("accepts a 403 as a valid key without user:read", async () => {
    vi.stubGlobal(
      "fetch",
      byRegion(jsonResponse(403, {}), jsonResponse(401, {})),
    );
    await expect(resolveMetadata({ apiKey: "phx_scoped" })).resolves.toEqual({
      region: "us",
      name: "API Key",
    });
  });

  it("never hard-fails when PostHog is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      byRegion(new Error("offline"), new Error("offline")),
    );
    await expect(resolveMetadata({ apiKey: "phx_k" })).resolves.toBeNull();
  });

  it("treats one region offline and the other 401 as inconclusive, not bad", async () => {
    vi.stubGlobal(
      "fetch",
      byRegion(new Error("offline"), jsonResponse(401, {})),
    );
    await expect(resolveMetadata({ apiKey: "phx_k" })).resolves.toBeNull();
  });
});
