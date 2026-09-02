import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The skills client is thin — URLs only — but both doors take ids that can
 * arrive DECODED from the URL, so the encoding is the behavior worth
 * pinning: a crafted segment must never re-aim the request onto a different
 * /v1 path under the caller's credentials.
 */

const apiGet = vi.fn();
const apiPatch = vi.fn();
vi.mock("./client", () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPatch: (...args: unknown[]) => apiPatch(...args),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
}));

const { get, orgUpdate } = await import("./skills");

beforeEach(() => {
  apiGet.mockReset();
  apiPatch.mockReset();
});

describe("skills client paths", () => {
  it("encodes the workspace-door id — a crafted segment must not re-aim the path", async () => {
    apiGet.mockResolvedValueOnce({});
    await get("../org/keys");
    expect(apiGet.mock.calls[0]?.[0]).toBe("/v1/skills/..%2Forg%2Fkeys");
  });

  it("encodes the org-door id the same way", async () => {
    apiPatch.mockResolvedValueOnce({});
    await orgUpdate("a/b", { enabled: false });
    expect(apiPatch.mock.calls[0]?.[0]).toBe("/v1/org/skills/a%2Fb");
  });
});
