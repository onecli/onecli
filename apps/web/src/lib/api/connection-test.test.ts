import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testConnection } from "./connection-test";

vi.mock("@/lib/gateway-url", () => ({
  getGatewayApiUrl: () => "https://gateway.example",
}));
vi.mock("@/lib/gateway-auth", () => ({
  getGatewayFetchOptions: async () => ({
    headers: {
      Authorization: "Bearer acting-user",
      "X-Workspace-Id": "ambient-workspace",
    },
    credentials: "include",
  }),
}));
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const success = () =>
  new Response(JSON.stringify({ ok: true, superuser: false }));

describe("stored connection test client", () => {
  it("aborts a blackholed request after 25 seconds and clears its timer", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const request = testConnection({
      connectionId: "saved",
      scope: { kind: "workspace", workspaceId: "w" },
    });
    const rejected = expect(request).rejects.toThrow("timed out. Try again.");
    await vi.advanceTimersByTimeAsync(25_000);
    await rejected;
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("also bounds stalled response-body reads", async () => {
    vi.useFakeTimers();
    const response = success();
    vi.spyOn(response, "json").mockImplementation(() => new Promise(() => {}));
    fetchMock.mockResolvedValue(response);
    const rejected = expect(
      testConnection({
        connectionId: "saved",
        scope: { kind: "workspace", workspaceId: "w" },
      }),
    ).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(25_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("sends only the encoded stored ID with explicit workspace and acting-user auth", async () => {
    fetchMock.mockResolvedValue(success());
    await expect(
      testConnection({
        connectionId: "a/b",
        scope: { kind: "workspace", workspaceId: "chosen" },
      }),
    ).resolves.toEqual({ ok: true, superuser: false });
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://gateway.example/v1/connections/a%2Fb/test");
    expect(options?.method).toBe("POST");
    expect(options?.body).toBeUndefined();
    expect(options?.credentials).toBe("include");
    const headers = new Headers(options?.headers);
    expect(headers.get("Authorization")).toBe("Bearer acting-user");
    expect(headers.get("X-Workspace-Id")).toBe("chosen");
    expect(headers.has("X-Organization-Id")).toBe(false);
  });
  it("org scope removes ambient workspace rather than testing a default workspace", async () => {
    fetchMock.mockResolvedValue(success());
    await testConnection({
      connectionId: "saved",
      scope: { kind: "organization", organizationId: "org" },
    });
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-Organization-Id")).toBe("org");
    expect(headers.has("X-Workspace-Id")).toBe(false);
  });
  it("fails closed before auth or fetch when scope is missing", async () => {
    await expect(
      testConnection({
        connectionId: "saved",
        scope: { kind: "organization", organizationId: undefined },
      }),
    ).rejects.toThrow("explicit connection scope");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("decodes nested gateway errors", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "CONNECTION_FAILED",
            message: "Database login refused",
            details: [],
          },
        }),
        { status: 422 },
      ),
    );
    await expect(
      testConnection({
        connectionId: "saved",
        scope: { kind: "workspace", workspaceId: "w" },
      }),
    ).rejects.toThrow("Database login refused");
  });
  it("rejects malformed success without claiming a successful connection", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    await expect(
      testConnection({
        connectionId: "saved",
        scope: { kind: "workspace", workspaceId: "w" },
      }),
    ).rejects.toThrow("invalid connection test result");
  });
});
