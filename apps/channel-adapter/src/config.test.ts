import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config";

/**
 * Boot config, the runner's law: a malformed anchor token is a ConfigError
 * (exit 2) at load time — never a daemon that boots and retries a 401
 * forever. Everything else has a local default so `docker run` with one env
 * var works.
 */

const base = { CHANNEL_ADAPTER_TOKEN: "cha_secret" };

describe("the anchor token", () => {
  it("refuses a missing token with a ConfigError", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it("refuses an empty token", () => {
    expect(() => loadConfig({ CHANNEL_ADAPTER_TOKEN: "" })).toThrow(
      ConfigError,
    );
  });

  it("refuses a token without the cha_ prefix (a runner token in the wrong slot)", () => {
    // The prefix is the family check: an rnr_ or aoc_ token pasted into the
    // wrong env var must die at boot with a pointed message, not register.
    expect(() => loadConfig({ CHANNEL_ADAPTER_TOKEN: "rnr_oops" })).toThrow(
      ConfigError,
    );
  });

  it("accepts a cha_ token", () => {
    expect(loadConfig(base).token).toBe("cha_secret");
  });
});

describe("defaults", () => {
  it("fills every address and cadence from the local-dev defaults", () => {
    expect(loadConfig(base)).toEqual({
      token: "cha_secret",
      name: "channel-adapter",
      controlPlaneUrl: "http://localhost:10256",
      gatewayUrl: "http://localhost:10255",
      configPollMs: 10_000,
      workPollMs: 2_000,
      approvalsPollSeconds: 25,
      appUrl: "",
    });
  });
});

describe("overrides", () => {
  it("takes every field from the environment", () => {
    expect(
      loadConfig({
        ...base,
        CHANNEL_ADAPTER_NAME: "prod adapter",
        CONTROL_PLANE_URL: "https://api.example.com",
        GATEWAY_API_URL: "https://gw.example.com",
        CHANNEL_ADAPTER_CONFIG_POLL_MS: "500",
        CHANNEL_ADAPTER_WORK_POLL_MS: "250",
        CHANNEL_ADAPTER_APPROVALS_POLL_SECONDS: "10",
        APP_URL: "https://app.example.com/",
      }),
    ).toEqual({
      token: "cha_secret",
      name: "prod adapter",
      controlPlaneUrl: "https://api.example.com",
      gatewayUrl: "https://gw.example.com",
      configPollMs: 500,
      workPollMs: 250,
      approvalsPollSeconds: 10,
      appUrl: "https://app.example.com",
    });
  });

  it("strips a trailing slash from both origins", () => {
    // Paths are appended as `/v1/...`, so a trailing slash would produce
    // `//v1` URLs that some proxies 404.
    const config = loadConfig({
      ...base,
      CONTROL_PLANE_URL: "https://api.example.com/",
      GATEWAY_API_URL: "https://gw.example.com/",
    });
    expect(config.controlPlaneUrl).toBe("https://api.example.com");
    expect(config.gatewayUrl).toBe("https://gw.example.com");
  });
});

describe("appUrl resolution", () => {
  // Pins the canonical configuredAppUrl() semantics (packages/api's
  // app-origin.ts): a merely-present env var is not a configured URL.
  it("falls through a present-but-empty APP_URL to NEXT_PUBLIC_APP_URL", () => {
    expect(
      loadConfig({
        ...base,
        APP_URL: "",
        NEXT_PUBLIC_APP_URL: "https://x.example",
      }).appUrl,
    ).toBe("https://x.example");
  });

  it("falls through a whitespace-only APP_URL", () => {
    expect(
      loadConfig({
        ...base,
        APP_URL: "   ",
        NEXT_PUBLIC_APP_URL: "https://x.example",
      }).appUrl,
    ).toBe("https://x.example");
  });

  it("strips every trailing slash, not just one", () => {
    expect(
      loadConfig({ ...base, APP_URL: "https://a.example///" }).appUrl,
    ).toBe("https://a.example");
  });

  it("trims surrounding whitespace before stripping slashes", () => {
    expect(
      loadConfig({ ...base, APP_URL: "  https://a.example/  " }).appUrl,
    ).toBe("https://a.example");
  });
});

describe("poll cadences", () => {
  it.each([
    ["junk", "not-a-number"],
    ["zero", "0"],
    ["negative", "-5"],
    ["fractional", "2.5"],
  ])("falls back to the default on a %s value", (_label, raw) => {
    const config = loadConfig({ ...base, CHANNEL_ADAPTER_WORK_POLL_MS: raw });
    expect(config.workPollMs).toBe(2_000);
  });

  it("accepts a positive integer", () => {
    expect(
      loadConfig({ ...base, CHANNEL_ADAPTER_CONFIG_POLL_MS: "1234" })
        .configPollMs,
    ).toBe(1234);
  });
});
