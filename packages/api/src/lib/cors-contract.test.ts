import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { afterEach, describe, expect, it } from "vitest";
import { trustedBrowserOrigin } from "./public-origins";

/**
 * The credentialed-CORS contract, driven through the REAL `hono/cors`
 * middleware rather than through the resolver alone.
 *
 * Why this exists as its own suite: the unit tests in `public-origins.test.ts`
 * prove which origins are TRUSTED, but the security property is what ends up
 * on the WIRE — an `Access-Control-Allow-Origin` header beside
 * `Access-Control-Allow-Credentials: true`. Those are two different things,
 * and the gap between them is exactly where this bug lived: the allow-list
 * function can be perfect while the middleware still reflects the request
 * origin, and no test of the resolver would notice.
 *
 * The wiring under test is `apps/api-server/src/app.ts`'s non-cloud arm. That
 * app cannot be imported here (it builds the whole api on module load —
 * database client, auth layer, edition graph), so this mirrors its cors()
 * options and the final describe block reads the real source to pin that the
 * mirror has not drifted from it. Reaching across the repo from this package
 * follows the precedent in `apps/app-permissions/catalog-json.test.ts`.
 *
 * What must stay true, in browser terms:
 *   - the deployment's own origins get the header (the dashboard keeps working)
 *   - every other origin gets NO header at all — never `*`, never itself
 *     echoed back — on preflight and on the actual request alike
 *   - `Vary: Origin` is present, so a shared cache cannot hand one origin's
 *     allow header to another
 */
const ENV_KEYS = [
  "ONECLI_EXTERNAL_URL",
  "APP_URL",
  "NEXT_PUBLIC_APP_URL",
  "API_URL",
  "NEXT_PUBLIC_API_URL",
  "ONECLI_APP_PORT",
  "ONECLI_API_PORT",
  "ONECLI_TRUSTED_ORIGINS",
] as const;

const orig: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) orig[key] = process.env[key];

const clearAll = () => {
  for (const key of ENV_KEYS) delete process.env[key];
};

/** The self-host arm of the api-server's cors() options, verbatim. */
const selfHostApp = () => {
  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: (origin) => trustedBrowserOrigin(origin) ?? null,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "X-Workspace-Id"],
      credentials: true,
    }),
  );
  app.get("/v1/agents", (c) => c.json({ agents: [] }));
  return app;
};

/** One request through the middleware; returns what a browser would see. */
const request = async (
  origin: string | undefined,
  method: "GET" | "OPTIONS" = "GET",
) => {
  const headers: Record<string, string> = {};
  if (origin !== undefined) headers.origin = origin;
  if (method === "OPTIONS") {
    headers["access-control-request-method"] = "GET";
    headers["access-control-request-headers"] = "content-type";
  }
  const res = await selfHostApp().request("http://api.test/v1/agents", {
    method,
    headers,
  });
  return {
    status: res.status,
    allowOrigin: res.headers.get("access-control-allow-origin"),
    allowCredentials: res.headers.get("access-control-allow-credentials"),
    vary: res.headers.get("vary"),
  };
};

describe("self-host credentialed CORS", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (orig[key] === undefined) delete process.env[key];
      else process.env[key] = orig[key];
    }
  });

  describe("refuses an untrusted origin", () => {
    // The regression this suite exists for. Reflecting the request origin
    // beside `credentials: true` let any page the victim visited call this
    // API with their session cookie AND read the response. `SameSite=lax`
    // does not save it: SameSite is SITE-scoped, so a sibling subdomain and
    // another port of the same host are both same-site and send the cookie.
    it("sends no allow-origin header on the actual request", async () => {
      clearAll();
      process.env.ONECLI_EXTERNAL_URL = "https://onecli.acme.com";
      const res = await request("https://evil.example");
      expect(res.allowOrigin).toBeNull();
    });

    it("sends no allow-origin header on the preflight", async () => {
      clearAll();
      process.env.ONECLI_EXTERNAL_URL = "https://onecli.acme.com";
      const res = await request("https://evil.example", "OPTIONS");
      expect(res.allowOrigin).toBeNull();
    });

    // A wildcard is inert beside credentials in a browser, but stating it
    // keeps a future "just allow *" edit from looking harmless.
    it("never answers with a wildcard", async () => {
      clearAll();
      process.env.ONECLI_EXTERNAL_URL = "https://onecli.acme.com";
      expect((await request("https://evil.example")).allowOrigin).not.toBe("*");
    });

    it("refuses a sibling subdomain, which is same-site", async () => {
      clearAll();
      process.env.ONECLI_EXTERNAL_URL = "https://onecli.acme.com";
      expect((await request("https://blog.acme.com")).allowOrigin).toBeNull();
    });

    it("refuses another port on the dashboard's own host", async () => {
      clearAll();
      process.env.ONECLI_EXTERNAL_URL = "http://192.0.2.10:10254";
      expect((await request("http://192.0.2.10:9999")).allowOrigin).toBeNull();
    });
  });

  describe("keeps every supported deployment shape working", () => {
    it("zero-config: the localhost dashboard and its loopback twin", async () => {
      clearAll();
      expect((await request("http://localhost:10254")).allowOrigin).toBe(
        "http://localhost:10254",
      );
      expect((await request("http://127.0.0.1:10254")).allowOrigin).toBe(
        "http://127.0.0.1:10254",
      );
    });

    it("LAN install: the configured address", async () => {
      clearAll();
      process.env.ONECLI_EXTERNAL_URL = "http://192.168.1.50:10254";
      expect((await request("http://192.168.1.50:10254")).allowOrigin).toBe(
        "http://192.168.1.50:10254",
      );
    });

    it("proxy mode: the single https origin", async () => {
      clearAll();
      process.env.ONECLI_EXTERNAL_URL = "https://onecli.acme.com";
      expect((await request("https://onecli.acme.com")).allowOrigin).toBe(
        "https://onecli.acme.com",
      );
    });

    it("split hosts: the dashboard origin reaching the api host", async () => {
      clearAll();
      process.env.ONECLI_EXTERNAL_URL = "https://app.acme.com";
      process.env.API_URL = "https://api.acme.com";
      expect((await request("https://app.acme.com")).allowOrigin).toBe(
        "https://app.acme.com",
      );
    });

    // The documented escape hatch for an install reachable at two addresses
    // (docs/self-hosting.md). It already unblocked sign-in; now it is also
    // what keeps the dashboard on that second address able to call the API.
    it("second address listed in ONECLI_TRUSTED_ORIGINS", async () => {
      clearAll();
      process.env.ONECLI_EXTERNAL_URL = "http://192.168.1.50:10254";
      process.env.ONECLI_TRUSTED_ORIGINS = "http://onecli.lan:10254";
      expect((await request("http://onecli.lan:10254")).allowOrigin).toBe(
        "http://onecli.lan:10254",
      );
    });

    it("legacy APP_URL alias installs", async () => {
      clearAll();
      process.env.APP_URL = "http://10.0.0.7:10254";
      expect((await request("http://10.0.0.7:10254")).allowOrigin).toBe(
        "http://10.0.0.7:10254",
      );
    });

    // Non-browser callers — the CLI, curl, the SDK, server-side fetches —
    // send no Origin at all. CORS is a browser mechanism: the absence of an
    // allow header must not become the absence of a RESPONSE.
    it("serves callers that send no Origin at all", async () => {
      clearAll();
      const res = await request(undefined);
      expect(res.status).toBe(200);
      expect(res.allowOrigin).toBeNull();
    });
  });

  // Without `Vary: Origin`, any shared cache in front of the API could serve
  // the dashboard's allow-origin header to a request from another origin,
  // reintroducing the hole at the cache layer.
  it("varies on Origin so a shared cache cannot cross the answers", async () => {
    clearAll();
    process.env.ONECLI_EXTERNAL_URL = "https://onecli.acme.com";
    expect((await request("https://onecli.acme.com")).vary).toContain("Origin");
    expect((await request("https://evil.example")).vary).toContain("Origin");
  });

  // Credentials stay on: the self-hosted dashboard authenticates with the
  // session cookie (`credentials: "include"` in apps/web/src/lib/api-fetch.ts),
  // so this is what the allow-list is protecting, not something to drop.
  it("keeps credentials enabled for the trusted origin", async () => {
    clearAll();
    process.env.ONECLI_EXTERNAL_URL = "https://onecli.acme.com";
    expect((await request("https://onecli.acme.com")).allowCredentials).toBe(
      "true",
    );
  });
});

// The behavioral suite above proves the RULE; these pin that the api-server is
// still wired to it. Source assertions rather than an import, because loading
// that module boots the whole api (the `layout-injection.test.ts` precedent).
describe("api-server CORS wiring", () => {
  const source = readFileSync(
    fileURLToPath(
      new URL("../../../../apps/api-server/src/app.ts", import.meta.url),
    ),
    "utf8",
  );

  // The exact regression: an `(origin) => origin` self-host arm reflects
  // whatever arrived. Any reintroduction has to fail a test, not a review.
  it("resolves the self-host origin through the trusted-origin allow-list", () => {
    expect(source).toMatch(
      /\(origin\)\s*=>\s*trustedBrowserOrigin\(origin\)\s*\?\?\s*null/,
    );
    expect(source).not.toMatch(
      /origin:\s*IS_CLOUD\s*\?[^;]*\(origin\)\s*=>\s*origin\b/,
    );
  });

  // Cloud is a fixed single-item list, unchanged by this work: browsers there
  // authenticate with a Cognito bearer token, not an ambient cookie.
  // Whitespace-insensitive so reformatting cannot fail this on style alone.
  it("keeps cloud pinned to the configured dashboard origin", () => {
    expect(source).toMatch(/IS_CLOUD\s*\?\s*\[appUrl\]/);
  });

  // Credentials on + an allow-list is the whole security posture. If a future
  // edit drops `credentials`, the dashboard's cookie auth breaks; if it drops
  // the allow-list, the hole returns. Pin both together.
  it("still sends credentials, which is what the allow-list guards", () => {
    expect(source).toContain("credentials: true");
  });
});
