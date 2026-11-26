// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  useKeeperSecurityPair,
  useKeeperSecurityReady,
} from "./use-keepersecurity";

// What matters here is the request body. A one-time token is single-use, so
// sending one as a "config" (or the reverse) would either spend it for nothing
// or fail late with a confusing error: the hook follows the method the user
// chose and never guesses from the pasted text.
vi.mock("@/lib/gateway-url", () => ({
  getGatewayApiUrl: () => "http://gw.test",
}));
vi.mock("@/lib/gateway-auth", () => ({
  getGatewayFetchOptions: async () => ({
    headers: { "X-Workspace-Id": "ws-1" },
    credentials: "include" as const,
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetchMock = vi.fn<typeof fetch>();
const respond = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
const lastCall = () => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return {
    url,
    init,
    body: init.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined,
  };
};

beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const pairHook = () => {
  const fetchStatus = vi.fn().mockResolvedValue(undefined);
  const hook = renderHook(() => useKeeperSecurityPair(fetchStatus));
  return { ...hook, fetchStatus };
};

describe("useKeeperSecurityPair", () => {
  it.each([
    "US:tpW8qZLAZklF_dfyYLtEr-6_JYLotWk-N5-zVhPq0DU",
    "GOV:abcDEF123",
    // Not shaped like today's tokens: the chosen method decides, not a pattern.
    "a-future-token-format",
  ])(
    "sends %s as a one-time token when that method is chosen",
    async (token) => {
      respond(200, { status: "paired" });
      const { result } = pairHook();
      await act(() => result.current.pair("one_time_token", token));
      expect(lastCall().body).toEqual({ one_time_token: token });
    },
  );

  it("sends a base64 string as a config", async () => {
    const config = "eyJob3N0bmFtZSI6ImtlZXBlcnNlY3VyaXR5LmNvbSJ9";
    respond(200, { status: "paired" });
    const { result } = pairHook();
    await act(() => result.current.pair("base64_config", config));
    expect(lastCall().body).toEqual({
      ksm_config: config,
      ksm_config_format: "base64",
    });
  });

  it("sends a JSON configuration as a config", async () => {
    const config = '{"hostname":"keepersecurity.com","clientId":"c"}';
    respond(200, { status: "paired" });
    const { result } = pairHook();
    await act(() => result.current.pair("json_config", config));
    expect(lastCall().body).toEqual({
      ksm_config: config,
      ksm_config_format: "json",
    });
  });

  // A config that happens to look like a token is still a config when the user
  // says so; the server explains what is wrong with it.
  it("never reinterprets a config as a token", async () => {
    respond(400, { error: "invalid keepersecurity KSM config" });
    const { result } = pairHook();
    await act(() => result.current.pair("base64_config", "US:abc123"));
    expect(lastCall().body).toEqual({
      ksm_config: "US:abc123",
      ksm_config_format: "base64",
    });
  });

  it.each([
    ["not JSON", "hostname=keepersecurity.com"],
    ["a JSON array", '["a"]'],
    ["a JSON string", '"abc"'],
  ])(
    "rejects %s for the JSON method without calling the gateway",
    async (_name, text) => {
      const { result } = pairHook();
      let ok = true;
      await act(async () => {
        ok = await result.current.pair("json_config", text);
      });
      expect(ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith(
        "The configuration is not a valid JSON object",
      );
    },
  );

  it("trims whitespace before sending", async () => {
    respond(200, { status: "paired" });
    const { result } = pairHook();
    await act(() => result.current.pair("one_time_token", "  US:abc123 \n"));
    expect(lastCall().body).toEqual({ one_time_token: "US:abc123" });
  });

  it("posts to the Keeper pair endpoint with the gateway's auth options", async () => {
    respond(200, { status: "paired" });
    const { result } = pairHook();
    await act(() => result.current.pair("one_time_token", "US:abc"));
    const { url, init } = lastCall();
    expect(url).toBe("http://gw.test/v1/vault/keepersecurity/pair");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Workspace-Id": "ws-1",
    });
  });

  it("refreshes status and reports success when paired", async () => {
    respond(200, { status: "paired" });
    const { result, fetchStatus } = pairHook();
    let ok = false;
    await act(async () => {
      ok = await result.current.pair("one_time_token", "US:abc");
    });
    expect(ok).toBe(true);
    expect(fetchStatus).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith("Keeper connected successfully");
  });

  it("shows the gateway's own error and does not refresh when pairing fails", async () => {
    respond(400, { error: "one-time token binding failed: already used" });
    const { result, fetchStatus } = pairHook();
    let ok = true;
    await act(async () => {
      ok = await result.current.pair("one_time_token", "US:abc");
    });
    expect(ok).toBe(false);
    expect(fetchStatus).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "one-time token binding failed: already used",
    );
  });

  it("falls back to a generic message when the error has no body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 502 }));
    const { result } = pairHook();
    await act(() => result.current.pair("one_time_token", "US:abc"));
    expect(toast.error).toHaveBeenCalledWith("Pairing failed");
  });

  it("reports an unreachable gateway", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("failed to fetch"));
    const { result } = pairHook();
    let ok = true;
    await act(async () => {
      ok = await result.current.pair("one_time_token", "US:abc");
    });
    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("Failed to connect to Keeper");
  });

  it.each(["", "   ", "\n\t"])(
    "sends nothing for blank input %j",
    async (blank) => {
      const { result } = pairHook();
      let ok = true;
      await act(async () => {
        ok = await result.current.pair("one_time_token", blank);
      });
      expect(ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith("Enter a one-time access token");
    },
  );

  it.each([
    ["base64_config", "Enter a base64 configuration"],
    ["json_config", "Enter a JSON configuration"],
  ] as const)(
    "names what is missing for the %s method",
    async (method, message) => {
      const { result } = pairHook();
      await act(() => result.current.pair(method, "  "));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith(message);
    },
  );

  it("reports pairing in progress, then clears it", async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (release = r)));
    const { result } = pairHook();
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.pair("one_time_token", "US:abc");
    });
    await waitFor(() => expect(result.current.pairing).toBe(true));
    await act(async () => {
      release(new Response("{}", { status: 200 }));
      await pending;
    });
    expect(result.current.pairing).toBe(false);
  });
});

describe("useKeeperSecurityReady", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
  );

  it("is ready when the gateway reports connected", async () => {
    respond(200, { connected: true });
    const { result } = renderHook(() => useKeeperSecurityReady(true), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(lastCall().url).toBe(
      "http://gw.test/v1/vault/keepersecurity/status",
    );
  });

  it("is not ready when disconnected", async () => {
    respond(200, { connected: false });
    const { result } = renderHook(() => useKeeperSecurityReady(true), {
      wrapper,
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.isReady).toBe(false);
  });

  it("is not ready when the status call fails", async () => {
    respond(500, { error: "boom" });
    const { result } = renderHook(() => useKeeperSecurityReady(true), {
      wrapper,
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.isReady).toBe(false);
  });

  it("does not call the gateway while the dialog is closed", async () => {
    renderHook(() => useKeeperSecurityReady(false), { wrapper });
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
