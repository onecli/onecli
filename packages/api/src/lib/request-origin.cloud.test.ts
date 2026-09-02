import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Cloud invariance pin: on cloud, both resolvers answer with the boot-time
 * `selfUrl` — never env URLs, never request headers. The api-server pins its
 * own address via `createApiApp({ selfUrl })`, so the OAuth redirect_uri was
 * already the API origin there; this file exists so the onprem fix can never
 * drift the cloud arm. Own file because `IS_CLOUD` is bound at module load and
 * the sibling `request-origin.test.ts` pins self-hosted.
 */

vi.mock("./env", () => ({
  IS_CLOUD: true,
  APP_URL: "http://localhost:10254",
}));

vi.mock("../providers/self-url", () => ({
  getSelfUrl: () => "https://api.cloud.example",
}));

import { getApiCallbackOrigin, getRequestOrigin } from "./request-origin";

const req = (headers: Record<string, string>) =>
  new Request("http://internal.local/x", { headers });

const URL_VARS = [
  "APP_URL",
  "NEXT_PUBLIC_APP_URL",
  "API_URL",
  "NEXT_PUBLIC_API_URL",
] as const;

describe("origin resolvers (cloud)", () => {
  const orig = Object.fromEntries(
    URL_VARS.map((key) => [key, process.env[key]]),
  );
  afterEach(() => {
    for (const key of URL_VARS) {
      if (orig[key] === undefined) delete process.env[key];
      else process.env[key] = orig[key];
    }
  });

  it("getApiCallbackOrigin returns selfUrl regardless of env and headers", () => {
    process.env.APP_URL = "https://dashboard.cloud.example";
    process.env.API_URL = "https://other-api.cloud.example";
    expect(
      getApiCallbackOrigin(
        req({ "x-forwarded-host": "forged.example", host: "arrived.example" }),
      ),
    ).toBe("https://api.cloud.example");
  });

  it("getRequestOrigin returns selfUrl regardless of env and headers", () => {
    process.env.APP_URL = "https://dashboard.cloud.example";
    expect(
      getRequestOrigin(
        req({ "x-forwarded-host": "forged.example", host: "arrived.example" }),
      ),
    ).toBe("https://api.cloud.example");
  });
});
