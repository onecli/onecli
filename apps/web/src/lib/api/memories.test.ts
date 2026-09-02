import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The memories client is thin — URLs only — but every path takes ids that
 * can arrive DECODED from the URL (`useParams`), so the encoding is the
 * behavior worth pinning: a crafted segment must never re-aim the request
 * onto a different /v1 path under the caller's credentials.
 */

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock("./client", () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPost: (...args: unknown[]) => apiPost(...args),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

const { get, restore, search } = await import("./memories");

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

describe("memories client paths", () => {
  it("encodes the agent and memory ids — a crafted segment must not re-aim the path", async () => {
    apiGet.mockResolvedValueOnce({});
    await get("../org/keys", "a/b");
    expect(apiGet.mock.calls[0]?.[0]).toBe(
      "/v1/agents/..%2Forg%2Fkeys/memories/a%2Fb",
    );
  });

  it("encodes every nested id on the revision actions", async () => {
    apiPost.mockResolvedValueOnce({});
    await restore("ag 1", "m/1", "r?x");
    expect(apiPost.mock.calls[0]?.[0]).toBe(
      "/v1/agents/ag%201/memories/m%2F1/revisions/r%3Fx/restore",
    );
  });

  it("encodes the search query", async () => {
    apiGet.mockResolvedValueOnce({ hits: [] });
    await search("ag-1", "a&b=c");
    expect(apiGet.mock.calls[0]?.[0]).toBe(
      "/v1/agents/ag-1/memories?q=a%26b%3Dc",
    );
  });
});
