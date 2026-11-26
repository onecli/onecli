import { afterEach, describe, expect, it, vi } from "vitest";
import { apolloIo } from "./apollo-io";

const resolveMetadata =
  apolloIo.connectionMethod.type === "api_key"
    ? apolloIo.connectionMethod.resolveMetadata
    : undefined;

if (!resolveMetadata) throw new Error("apollo-io must expose resolveMetadata");

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("apollo-io resolveMetadata", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Apollo authenticates API keys via `x-api-key`; a key sent as a Bearer
  // token is rejected (docs.apollo.io/reference/authentication).
  it("probes /users/api_profile with the trimmed key in x-api-key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { email: "a@b.co" }));
    vi.stubGlobal("fetch", fetchMock);
    await resolveMetadata({ apiKey: "  key123\n" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.apollo.io/api/v1/users/api_profile",
      { headers: { "x-api-key": "key123" } },
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("hard-fails on 401 — the one response that proves the key is bad", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, {})));
    await expect(resolveMetadata({ apiKey: "revoked" })).rejects.toThrow(
      /Apollo rejected this API key/,
    );
  });

  // A scoped key that wasn't granted the profile endpoint answers 403. That
  // is the least-privilege setup Apollo recommends, so it must connect.
  it("accepts a 403 — a valid key without the profile endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(403, {})));
    await expect(resolveMetadata({ apiKey: "scoped" })).resolves.toBeNull();
  });

  it("never hard-fails when Apollo is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(resolveMetadata({ apiKey: "k" })).resolves.toBeNull();
  });

  it("maps the profile into connection metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          id: "u1",
          team_id: "t1",
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com",
        }),
      ),
    );
    await expect(resolveMetadata({ apiKey: "k" })).resolves.toEqual({
      username: "jane@example.com",
      email: "jane@example.com",
      name: "Jane Doe",
      userId: "u1",
      teamId: "t1",
    });
  });

  it("falls back to the name as username when the profile has no email", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse(200, { first_name: "Jane", id: "u1" })),
    );
    await expect(resolveMetadata({ apiKey: "k" })).resolves.toMatchObject({
      username: "Jane",
      name: "Jane",
    });
  });

  it("returns null for an empty profile so the generic label applies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, {})));
    await expect(resolveMetadata({ apiKey: "k" })).resolves.toBeNull();
  });
});
