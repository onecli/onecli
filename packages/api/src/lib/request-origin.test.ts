import { afterEach, describe, expect, it, vi } from "vitest";

// Force the self-hosted branch (IS_CLOUD false) regardless of the ambient edition.
vi.mock("./env", () => ({
  IS_CLOUD: false,
  APP_URL: "http://localhost:10254",
}));

import { getRequestOrigin } from "./request-origin";

const req = (headers: Record<string, string>) =>
  new Request("http://internal.local/x", { headers });

describe("getRequestOrigin (self-hosted)", () => {
  const orig = {
    APP_URL: process.env.APP_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  };
  afterEach(() => {
    for (const key of ["APP_URL", "NEXT_PUBLIC_APP_URL"] as const) {
      if (orig[key] === undefined) delete process.env[key];
      else process.env[key] = orig[key];
    }
  });

  it("prefers a configured APP_URL, stripping trailing slashes", () => {
    process.env.APP_URL = "https://onecli.example.com/";
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(getRequestOrigin(req({ "x-forwarded-host": "proxy.local" }))).toBe(
      "https://onecli.example.com",
    );
  });

  it("uses NEXT_PUBLIC_APP_URL when APP_URL is unset", () => {
    delete process.env.APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://public.example.com";
    expect(getRequestOrigin(req({ "x-forwarded-host": "proxy.local" }))).toBe(
      "https://public.example.com",
    );
  });

  it("falls back to x-forwarded-host when no public URL is configured", () => {
    delete process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(
      getRequestOrigin(
        req({
          "x-forwarded-host": "proxy.example.com",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe("https://proxy.example.com");
  });
});
