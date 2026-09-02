import { afterEach, describe, expect, it, vi } from "vitest";

// Force the self-hosted branch (IS_CLOUD false) regardless of the ambient edition.
vi.mock("./env", () => ({
  IS_CLOUD: false,
  APP_URL: "http://localhost:10254",
}));

// Pin the boot-time self URL so the last-resort fallback is distinguishable
// from every env-derived answer.
vi.mock("../providers/self-url", () => ({
  getSelfUrl: () => "http://self.example",
}));

import {
  getApiCallbackOrigin,
  getAppOrigin,
  getRequestOrigin,
} from "./request-origin";
import { normalizeOrigin } from "./app-origin";

const req = (headers: Record<string, string>) =>
  new Request("http://internal.local/x", { headers });

const URL_VARS = [
  "APP_URL",
  "NEXT_PUBLIC_APP_URL",
  "API_URL",
  "NEXT_PUBLIC_API_URL",
] as const;

const snapshotUrlVars = () => {
  const orig = Object.fromEntries(
    URL_VARS.map((key) => [key, process.env[key]]),
  );
  return () => {
    for (const key of URL_VARS) {
      if (orig[key] === undefined) delete process.env[key];
      else process.env[key] = orig[key];
    }
  };
};

const unconfigured = () => {
  for (const key of URL_VARS) delete process.env[key];
};

describe("getRequestOrigin (self-hosted)", () => {
  const restore = snapshotUrlVars();
  afterEach(restore);

  // The old behavior this replaced: a configured APP_URL used to hijack the
  // answer, sending OAuth redirect URIs to the dashboard host (no /v1 there).
  it("ignores a configured APP_URL — the request's own origin wins", () => {
    unconfigured();
    process.env.APP_URL = "https://dashboard.example.com";
    expect(getRequestOrigin(req({ "x-forwarded-host": "proxy.local" }))).toBe(
      "http://proxy.local",
    );
  });

  it("falls back to x-forwarded-host when no public URL is configured", () => {
    unconfigured();
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

describe("getApiCallbackOrigin (self-hosted)", () => {
  const restore = snapshotUrlVars();
  afterEach(restore);

  it("prefers a configured API_URL, stripping trailing slashes", () => {
    unconfigured();
    process.env.API_URL = "https://api.example.com/";
    expect(
      getApiCallbackOrigin(req({ "x-forwarded-host": "proxy.local" })),
    ).toBe("https://api.example.com");
  });

  it("uses NEXT_PUBLIC_API_URL when API_URL is unset", () => {
    unconfigured();
    process.env.NEXT_PUBLIC_API_URL = "https://api-public.example.com";
    expect(
      getApiCallbackOrigin(req({ "x-forwarded-host": "proxy.local" })),
    ).toBe("https://api-public.example.com");
  });

  it("never consults APP_URL — the dashboard serves no /v1", () => {
    unconfigured();
    process.env.APP_URL = "https://dashboard.example.com";
    process.env.NEXT_PUBLIC_APP_URL = "https://dashboard.example.com";
    expect(
      getApiCallbackOrigin(
        req({
          "x-forwarded-host": "proxy.example.com",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe("https://proxy.example.com");
  });

  it("treats a blank API_URL as unconfigured and derives from headers", () => {
    unconfigured();
    process.env.API_URL = "   ";
    expect(getApiCallbackOrigin(req({ host: "box.local:10256" }))).toBe(
      "http://box.local:10256",
    );
  });

  it("falls back to the boot-time self URL when nothing else answers", () => {
    unconfigured();
    expect(getApiCallbackOrigin(req({}))).toBe("http://self.example");
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

describe("getAppOrigin — trusted referer (the unconfigured OAuth landing)", () => {
  const restore = snapshotUrlVars();
  afterEach(() => {
    restore();
    delete process.env.ONECLI_EXTERNAL_URL;
    delete process.env.ONECLI_TRUSTED_ORIGINS;
  });

  // The zero-config regression pin: /authorize is a top-level navigation
  // FROM the dashboard, arriving ON the api origin. Without the referer step
  // the signed origin becomes the API origin and the post-connect browser
  // lands on this server's JSON 404 instead of the dashboard.
  it("prefers a trusted referer over the request's own (api) origin", () => {
    unconfigured();
    expect(
      getAppOrigin(
        req({
          host: "localhost:10256",
          referer: "http://localhost:10254/w/w1/connections",
        }),
      ),
    ).toBe("http://localhost:10254");
    // The loopback twin is trusted too.
    expect(
      getAppOrigin(
        req({ host: "127.0.0.1:10256", referer: "http://127.0.0.1:10254/" }),
      ),
    ).toBe("http://127.0.0.1:10254");
  });

  // A referer is cross-site-influenceable (SameSite=Lax sends the session
  // cookie on top-level GETs), so an UNLISTED origin must never steer the
  // post-consent landing — it falls through to the request origin exactly
  // as before this step existed.
  it("ignores an untrusted referer", () => {
    unconfigured();
    expect(
      getAppOrigin(
        req({ host: "arrived.example", referer: "https://evil.example/lure" }),
      ),
    ).toBe("http://arrived.example");
  });

  it("honors ONECLI_TRUSTED_ORIGINS extras", () => {
    unconfigured();
    process.env.ONECLI_TRUSTED_ORIGINS = "http://onecli.corp:10254";
    expect(
      getAppOrigin(
        req({
          host: "arrived.example",
          referer: "http://onecli.corp:10254/w/w1",
        }),
      ),
    ).toBe("http://onecli.corp:10254");
  });

  it("loses to a configured URL and to a signed origin", () => {
    unconfigured();
    process.env.ONECLI_EXTERNAL_URL = "http://configured.example:10254";
    expect(
      getAppOrigin(req({ host: "x", referer: "http://localhost:10254/" })),
    ).toBe("http://configured.example:10254");
    delete process.env.ONECLI_EXTERNAL_URL;
    unconfigured();
    expect(
      getAppOrigin(
        req({ host: "x", referer: "http://localhost:10254/" }),
        "https://signed.example",
      ),
    ).toBe("https://signed.example");
  });
});
