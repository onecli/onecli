import { afterEach, describe, expect, it, vi } from "vitest";

// GATEWAY_SERVICE_URL is the URL the API server uses to reach the gateway for
// server-to-server calls (cache invalidation). It must default to
// GATEWAY_API_URL so existing single-stack and remote-gateway ("cloud")
// deployments are unaffected, and be independently overridable so a port-offset
// self-hosted stack can pin it to the gateway's fixed in-container port while
// the advertised GATEWAY_API_URL tracks the remapped host port.
describe("GATEWAY_SERVICE_URL", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("falls back to GATEWAY_API_URL when unset", async () => {
    vi.stubEnv("GATEWAY_API_URL", "http://gw.example:9999");
    vi.stubEnv("GATEWAY_SERVICE_URL", undefined);
    vi.resetModules();

    const env = await import("./env");

    expect(env.GATEWAY_SERVICE_URL).toBe("http://gw.example:9999");
  });

  it("uses GATEWAY_SERVICE_URL when set, independent of GATEWAY_API_URL", async () => {
    vi.stubEnv("GATEWAY_API_URL", "http://gw.example:9999");
    vi.stubEnv("GATEWAY_SERVICE_URL", "http://127.0.0.1:10255");
    vi.resetModules();

    const env = await import("./env");

    expect(env.GATEWAY_SERVICE_URL).toBe("http://127.0.0.1:10255");
    // The advertised URL is unchanged — the two are decoupled.
    expect(env.GATEWAY_API_URL).toBe("http://gw.example:9999");
  });
});
