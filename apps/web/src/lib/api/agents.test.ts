import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The agents client is thin — URLs only — but its detail path takes an id
 * that can arrive DECODED from the URL (`useParams`), so the encoding is the
 * one behavior worth pinning (the round-1 review's recorded follow-up).
 */

const apiGet = vi.fn();
const apiPatch = vi.fn();
const apiUpload = vi.fn();
vi.mock("@/lib/api-fetch", () => ({
  apiUpload: (...args: unknown[]) => apiUpload(...args),
}));
vi.mock("./client", async (importOriginal) => ({
  // The pure helpers (`workspaceScope`) stay real; only the transport is
  // replaced.
  ...(await importOriginal<typeof import("./client")>()),
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPatch: (...args: unknown[]) => apiPatch(...args),
  apiPost: vi.fn(),
}));

const { get, update, uploadImage } = await import("./agents");

beforeEach(() => {
  apiGet.mockReset();
  apiPatch.mockReset();
  apiUpload.mockReset();
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
    // No workspace named: no scope header rides along.
    expect(apiPatch.mock.calls[0]?.[2]).toBeUndefined();
  });

  it("scopes an update to a named workspace (the onboarding rename)", async () => {
    apiPatch.mockResolvedValueOnce({ success: true });
    await update("ag-1", { name: "Max" }, { workspaceId: "ws-1" });
    expect(apiPatch.mock.calls[0]?.[2]).toEqual({
      headers: { "X-Workspace-Id": "ws-1" },
    });
  });

  it("scopes the avatar upload to a named workspace (onboarding's starter picture)", async () => {
    apiUpload.mockResolvedValueOnce(
      new Response(JSON.stringify({ imageUrl: "u" }), { status: 200 }),
    );
    const file = new Blob(["x"], { type: "image/jpeg" });
    await uploadImage("ag-1", file, { workspaceId: "ws-1" });
    expect(apiUpload).toHaveBeenCalledWith("/v1/agents/ag-1/image", file, {
      method: "PUT",
      contentType: "image/jpeg",
      workspaceId: "ws-1",
    });
  });
});
