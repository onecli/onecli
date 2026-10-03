import { afterEach, describe, expect, it, vi } from "vitest";
import { clay } from "./clay";

const resolveMetadata =
  clay.connectionMethod.type === "api_key"
    ? clay.connectionMethod.resolveMetadata
    : undefined;

if (!resolveMetadata) throw new Error("clay must expose resolveMetadata");

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("clay resolveMetadata", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Clay's Public API reads the key from `clay-api-key`, never Authorization
  // (developers.clay.com/public-api/authentication).
  it("probes /public/v0/me with the trimmed key in clay-api-key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { user: { id: "u1" } }));
    vi.stubGlobal("fetch", fetchMock);
    await resolveMetadata({ apiKey: " key \n" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clay.com/public/v0/me",
      {
        headers: { "clay-api-key": "key" },
      },
    );
  });

  it.each([401, 403])(
    "hard-fails on %s — Clay rejected the key",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse(status, { message: "nope" })),
      );
      await expect(resolveMetadata({ apiKey: "bad" })).rejects.toThrow(
        /Clay rejected this API key/,
      );
    },
  );

  it("never hard-fails when Clay is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(resolveMetadata({ apiKey: "k" })).resolves.toBeNull();
  });

  // The `/me` shape per Clay's OpenAPI: user{id,name,email|null},
  // workspace{id,name|null}. Nulls must map to undefined, not leak as null.
  it("maps user and workspace into connection metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          user: { id: "u1", name: "Jane Doe", email: "jane@example.com" },
          workspace: { id: "w1", name: "Acme" },
        }),
      ),
    );
    await expect(resolveMetadata({ apiKey: "k" })).resolves.toEqual({
      username: "jane@example.com",
      email: "jane@example.com",
      name: "Jane Doe",
      workspaceName: "Acme",
      workspaceId: "w1",
    });
  });

  it("falls back to the user's name when email is null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          user: { id: "u1", name: "Jane", email: null },
          workspace: { id: "w1", name: null },
        }),
      ),
    );
    await expect(resolveMetadata({ apiKey: "k" })).resolves.toEqual({
      username: "Jane",
      email: undefined,
      name: "Jane",
      workspaceName: undefined,
      workspaceId: "w1",
    });
  });

  it("returns null on an unexpected body so the generic label applies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, {})));
    await expect(resolveMetadata({ apiKey: "k" })).resolves.toBeNull();
  });
});
