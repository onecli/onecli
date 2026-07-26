import { afterEach, describe, expect, it, vi } from "vitest";

// Force the self-hosted branch (IS_CLOUD false) regardless of the ambient edition.
vi.mock("./env", () => ({
  IS_CLOUD: false,
  APP_URL: "http://localhost:10254",
}));

import { getAppOrigin, getRequestOrigin } from "./request-origin";
import { normalizeOrigin } from "./app-origin";

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

describe("getAppOrigin", () => {
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

  const unconfigured = () => {
    delete process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
  };

  it("prefers a signed origin over the request's own", () => {
    unconfigured();
    expect(
      getAppOrigin(req({ host: "arrived.example" }), "https://signed.example"),
    ).toBe("https://signed.example");
  });

  it("keeps a configured APP_URL ahead of a signed origin", () => {
    process.env.APP_URL = "https://configured.example";
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(
      getAppOrigin(req({ host: "arrived.example" }), "https://signed.example"),
    ).toBe("https://configured.example");
  });

  it("ignores an absent or unusable signed origin", () => {
    unconfigured();
    for (const bad of [undefined, "", "javascript:alert(1)", 42]) {
      expect(getAppOrigin(req({ host: "arrived.example" }), bad)).toBe(
        "http://arrived.example",
      );
    }
  });

  // The round trip that keeps the two halves honest: `/authorize` signs whatever
  // this returns, and `/callback` reads it back through normalizeOrigin. If the
  // producer could emit something the reader rejects, the signed origin would
  // silently drop out and the hardening would be a no-op.
  it("produces an origin that normalizeOrigin accepts", () => {
    unconfigured();
    const cases: Record<string, string>[] = [
      { host: "box.local" },
      { host: "box.local:10254" },
      { "x-forwarded-host": "proxy.example.com", "x-forwarded-proto": "https" },
    ];
    for (const headers of cases) {
      const produced = getAppOrigin(req(headers));
      expect(normalizeOrigin(produced)).toBe(produced);
    }

    process.env.APP_URL = "https://onecli.example.com/";
    const configured = getAppOrigin(req({ host: "box.local" }));
    expect(normalizeOrigin(configured)).toBe(configured);
  });
});
