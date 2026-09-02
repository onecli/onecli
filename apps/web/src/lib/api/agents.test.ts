import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The agents client is thin — URLs only — but its detail path takes an id
 * that can arrive DECODED from the URL (`useParams`), so the encoding is the
 * one behavior worth pinning (the round-1 review's recorded follow-up).
 */

const apiGet = vi.fn();
const apiPatch = vi.fn();
vi.mock("./client", () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPatch: (...args: unknown[]) => apiPatch(...args),
  apiPost: vi.fn(),
}));

const { get, update } = await import("./agents");

beforeEach(() => {
  apiGet.mockReset();
  apiPatch.mockReset();
});

describe("agents client paths", () => {
  it("encodes the detail id — a crafted segment must not re-aim the path", async () => {
    apiGet.mockResolvedValueOnce({});
    await get("../org/keys");
    expect(apiGet.mock.calls[0]?.[0]).toBe("/v1/agents/..%2Forg%2Fkeys");
  });

  it("encodes the update id the same way", async () => {
    apiPatch.mockResolvedValueOnce({ success: true });
    await update("a b", { instructions: null });
    expect(apiPatch.mock.calls[0]?.[0]).toBe("/v1/agents/a%20b");
    expect(apiPatch.mock.calls[0]?.[1]).toEqual({ instructions: null });
  });
});
