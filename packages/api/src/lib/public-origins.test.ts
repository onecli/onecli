import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OriginConfigError,
  buildTrustedOrigins,
  configuredApiUrl,
  configuredAppUrl,
  formatOriginsBanner,
  resolveOriginsFromEnv,
  resolvePublicOrigins,
  trustedBrowserOrigin,
} from "./public-origins";

describe("resolvePublicOrigins — derivation", () => {
  // The zero-config contract: byte-identical to the pre-refactor lib/env.ts
  // constants, so a defaults-everything install behaves exactly as before.
  it("yields the historical localhost defaults when nothing is set", () => {
    const r = resolvePublicOrigins({});
    expect(r.external).toBe("http://localhost:10254");
    expect(r.api).toBe("http://localhost:10256");
    expect(r.gateway).toBe("http://localhost:10255");
    expect(r.agentProxyAddress).toBe("host.docker.internal:10255");
    expect(r.mode).toBe("ports");
    expect(r.externalConfigured).toBe(false);
    expect(r.sources.external.source).toBe("default");
    expect(r.sources.api.source).toBe("default");
    expect(r.warnings).toEqual([]);
  });

  it("flows custom ports into every default and derivation", () => {
    const r = resolvePublicOrigins({
      appPort: "24812",
      apiPort: "24813",
      gatewayPort: "24814",
    });
    expect(r.external).toBe("http://localhost:24812");
    expect(r.api).toBe("http://localhost:24813");
    expect(r.gateway).toBe("http://localhost:24814");
  });

  it("ignores malformed port values in favor of the defaults", () => {
    const r = resolvePublicOrigins({ apiPort: "not-a-port", appPort: "0" });
    expect(r.external).toBe("http://localhost:10254");
    expect(r.api).toBe("http://localhost:10256");
  });

  it("http external means ports mode: same host, service ports", () => {
    const r = resolvePublicOrigins({
      externalUrl: "http://192.0.2.10:24812",
      apiPort: "24813",
      gatewayPort: "24814",
    });
    expect(r.mode).toBe("ports");
    expect(r.app).toBe("http://192.0.2.10:24812");
    expect(r.api).toBe("http://192.0.2.10:24813");
    expect(r.gateway).toBe("http://192.0.2.10:24814");
    expect(r.externalConfigured).toBe(true);
    expect(r.sources.external).toEqual({
      source: "set",
      envVar: "ONECLI_EXTERNAL_URL",
    });
    expect(r.sources.api.source).toBe("derived");
  });

  it("https external means proxy mode: one origin, /gw prefix", () => {
    const r = resolvePublicOrigins({
      externalUrl: "https://onecli.acme.com",
    });
    expect(r.mode).toBe("proxy");
    expect(r.api).toBe("https://onecli.acme.com");
    expect(r.gateway).toBe("https://onecli.acme.com/gw");
  });

  it("APP_URL and NEXT_PUBLIC_APP_URL act as alias heads, in that order", () => {
    expect(
      resolvePublicOrigins({ appUrl: "http://alias.example:10254" }).external,
    ).toBe("http://alias.example:10254");
    expect(
      resolvePublicOrigins({ nextPublicAppUrl: "http://np.example:10254" })
        .sources.external,
    ).toEqual({ source: "alias", envVar: "NEXT_PUBLIC_APP_URL" });
    expect(
      resolvePublicOrigins({
        appUrl: "http://alias.example",
        nextPublicAppUrl: "http://np.example",
      }).external,
    ).toBe("http://alias.example");
  });

  // The frozen legacy contract: APP_URL names the dashboard ONLY. In a split
  // deployment that host serves no /v1, and existing installs rely on the
  // header-origin fallback a derived answer would silently disable.
  it("a bare APP_URL alias never derives the api/gateway origins", () => {
    const r = resolvePublicOrigins({ appUrl: "https://dashboard.example.com" });
    expect(r.app).toBe("https://dashboard.example.com");
    expect(r.api).toBe("http://localhost:10256");
    expect(r.gateway).toBe("http://localhost:10255");
    expect(r.sources.api.source).toBe("default");
  });

  it("canonical beats alias, with a conflict warning", () => {
    const r = resolvePublicOrigins({
      externalUrl: "http://canonical.example:10254",
      appUrl: "http://alias.example:10254",
    });
    expect(r.external).toBe("http://canonical.example:10254");
    expect(r.warnings.some((w) => w.includes("disagree"))).toBe(true);
  });

  it("does not warn when canonical and alias agree", () => {
    const r = resolvePublicOrigins({
      externalUrl: "http://same.example:10254",
      appUrl: "http://same.example:10254/",
    });
    expect(r.warnings).toEqual([]);
  });

  it("API_URL and GATEWAY_API_URL overrides beat derivation in both modes", () => {
    const ports = resolvePublicOrigins({
      externalUrl: "http://one.example:10254",
      apiUrl: "https://api.acme.com",
      gatewayApiUrl: "https://gw.acme.com",
    });
    expect(ports.api).toBe("https://api.acme.com");
    expect(ports.gateway).toBe("https://gw.acme.com");
    expect(ports.sources.api).toEqual({ source: "set", envVar: "API_URL" });

    const proxy = resolvePublicOrigins({
      externalUrl: "https://app.acme.com",
      apiUrl: "https://api.acme.com",
    });
    expect(proxy.api).toBe("https://api.acme.com");
    expect(proxy.gateway).toBe("https://app.acme.com/gw");
  });

  // The compose pass-through rows (`APP_URL: ${APP_URL:-}`) deliver empty
  // strings into containers — blank must mean unset on every head.
  it("treats blank and whitespace-only values as unset on every head", () => {
    const r = resolvePublicOrigins({
      externalUrl: "",
      appUrl: "   ",
      apiUrl: "",
      gatewayApiUrl: " ",
      bindHost: "",
      agentProxyAddress: "",
      gatewayBaseUrl: "  ",
    });
    expect(r.external).toBe("http://localhost:10254");
    expect(r.api).toBe("http://localhost:10256");
    expect(r.agentProxyAddress).toBe("host.docker.internal:10255");
    expect(r.externalConfigured).toBe(false);
  });

  it("strips trailing slashes everywhere", () => {
    const r = resolvePublicOrigins({
      externalUrl: "https://onecli.acme.com///",
      apiUrl: "https://api.acme.com/",
    });
    expect(r.external).toBe("https://onecli.acme.com");
    expect(r.api).toBe("https://api.acme.com");
    expect(r.gateway).toBe("https://onecli.acme.com/gw");
  });

  it("legacy APP_URL values stay lenient — no validation hard-fail", () => {
    // A value that has worked for an existing install must keep working.
    const r = resolvePublicOrigins({ appUrl: "weird-but-mine:10254" });
    expect(r.external).toBe("weird-but-mine:10254");
  });
});

describe("resolvePublicOrigins — ONECLI_EXTERNAL_URL validation", () => {
  it("rejects a missing scheme, naming the fix", () => {
    expect(() =>
      resolvePublicOrigins({ externalUrl: "onecli.acme.com" }),
    ).toThrowError(OriginConfigError);
    expect(() =>
      resolvePublicOrigins({ externalUrl: "onecli.acme.com" }),
    ).toThrowError(/http:\/\/ or https:\/\//);
  });

  it("rejects wildcard bind addresses, pointing at ONECLI_BIND_HOST", () => {
    for (const host of ["0.0.0.0", "[::]"]) {
      expect(() =>
        resolvePublicOrigins({ externalUrl: `http://${host}:10254` }),
      ).toThrowError(/bind address/);
    }
  });

  it("rejects paths, queries, and credentials", () => {
    for (const url of [
      "https://onecli.acme.com/sub",
      "https://onecli.acme.com?x=1",
      "https://user:pass@onecli.acme.com",
    ]) {
      expect(() => resolvePublicOrigins({ externalUrl: url })).toThrowError(
        OriginConfigError,
      );
    }
  });
});

describe("resolvePublicOrigins — legacy bind seed", () => {
  it("seeds the external URL from a non-loopback bind host, warned", () => {
    const r = resolvePublicOrigins({ bindHost: "172.17.0.1" });
    expect(r.external).toBe("http://172.17.0.1:10254");
    expect(r.externalConfigured).toBe(true);
    expect(r.sources.external).toEqual({
      source: "legacy-bind",
      envVar: "ONECLI_BIND_HOST",
    });
    expect(
      r.warnings.some((w) =>
        w.includes("ONECLI_EXTERNAL_URL=http://172.17.0.1:10254"),
      ),
    ).toBe(true);
  });

  it("respects a custom app port in the seeded URL", () => {
    const r = resolvePublicOrigins({ bindHost: "10.0.0.5", appPort: "24812" });
    expect(r.external).toBe("http://10.0.0.5:24812");
    expect(r.api).toBe("http://10.0.0.5:10256");
  });

  it("never seeds from loopback or wildcard binds", () => {
    for (const bindHost of ["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"]) {
      const r = resolvePublicOrigins({ bindHost });
      expect(r.external).toBe("http://localhost:10254");
      expect(r.externalConfigured).toBe(false);
    }
  });

  it("loses to any configured URL head", () => {
    const r = resolvePublicOrigins({
      bindHost: "172.17.0.1",
      appUrl: "http://real.example:10254",
    });
    expect(r.external).toBe("http://real.example:10254");
    expect(r.warnings).toEqual([]);
  });
});

describe("resolvePublicOrigins — agent proxy address", () => {
  it("prefers the new name and validates it", () => {
    const r = resolvePublicOrigins({
      agentProxyAddress: "172.17.0.1:10255",
      gatewayBaseUrl: "old.example:10255",
    });
    expect(r.agentProxyAddress).toBe("172.17.0.1:10255");
    expect(r.warnings).toEqual([]);
  });

  it("rejects a scheme in the new name", () => {
    expect(() =>
      resolvePublicOrigins({ agentProxyAddress: "http://gateway:10255" }),
    ).toThrowError(/scheme-less/i);
  });

  it("accepts legacy GATEWAY_BASE_URL verbatim, with one deprecation warning", () => {
    const r = resolvePublicOrigins({ gatewayBaseUrl: "gateway:10255" });
    expect(r.agentProxyAddress).toBe("gateway:10255");
    expect(r.sources.agentProxyAddress).toEqual({
      source: "alias",
      envVar: "GATEWAY_BASE_URL",
    });
    expect(r.warnings.some((w) => w.includes("GATEWAY_BASE_URL"))).toBe(true);
  });

  // The default never derives from the external host: external=localhost
  // would hand containers an address that resolves to themselves.
  it("defaults to host.docker.internal regardless of the external URL", () => {
    const r = resolvePublicOrigins({ externalUrl: "http://192.0.2.9:10254" });
    expect(r.agentProxyAddress).toBe("host.docker.internal:10255");
  });
});

describe("buildTrustedOrigins", () => {
  it("single-host default trusts the app origin and its loopback twin", () => {
    const { origins, warnings } = buildTrustedOrigins(resolvePublicOrigins({}));
    expect(origins).toEqual([
      "http://localhost:10254",
      "http://127.0.0.1:10254",
    ]);
    expect(warnings).toEqual([]);
  });

  it("twins work in both directions", () => {
    const { origins } = buildTrustedOrigins(
      resolvePublicOrigins({ externalUrl: "http://127.0.0.1:10254" }),
    );
    expect(origins).toContain("http://localhost:10254");
  });

  it("non-loopback hosts get no twin", () => {
    const { origins } = buildTrustedOrigins(
      resolvePublicOrigins({ externalUrl: "http://192.0.2.10:10254" }),
    );
    expect(origins).toEqual(["http://192.0.2.10:10254"]);
  });

  it("merges the extras csv, dropping invalid entries with a warning", () => {
    const { origins, warnings } = buildTrustedOrigins(
      resolvePublicOrigins({ externalUrl: "http://192.0.2.10:10254" }),
      "http://onecli.corp:10254, not-an-origin ,https://alias.example",
    );
    expect(origins).toContain("http://onecli.corp:10254");
    expect(origins).toContain("https://alias.example");
    expect(warnings.some((w) => w.includes("not-an-origin"))).toBe(true);
  });

  it("split hosts add the api origin (and its twin)", () => {
    const { origins } = buildTrustedOrigins(
      resolvePublicOrigins({
        externalUrl: "https://app.acme.com",
        apiUrl: "https://api.acme.com",
      }),
    );
    expect(origins).toEqual(["https://app.acme.com", "https://api.acme.com"]);
  });

  it("same-host different-port api adds nothing (cookies ignore ports)", () => {
    const { origins } = buildTrustedOrigins(resolvePublicOrigins({}));
    expect(origins).not.toContain("http://localhost:10256");
  });

  it("a DEFAULTED api origin beside an alias app host adds nothing", () => {
    const { origins } = buildTrustedOrigins(
      resolvePublicOrigins({ appUrl: "https://onecli.example.com" }),
    );
    expect(origins).toEqual(["https://onecli.example.com"]);
  });

  it("dedupes", () => {
    const { origins } = buildTrustedOrigins(
      resolvePublicOrigins({ externalUrl: "http://localhost:10254" }),
      "http://localhost:10254,http://127.0.0.1:10254",
    );
    expect(origins).toEqual([
      "http://localhost:10254",
      "http://127.0.0.1:10254",
    ]);
  });
});

describe("formatOriginsBanner", () => {
  it("tags every line with its source", () => {
    const lines = formatOriginsBanner(
      resolvePublicOrigins({
        externalUrl: "https://onecli.acme.com",
        gatewayBaseUrl: "gw.internal:10255",
      }),
    );
    expect(lines[0]).toContain("mode: proxy");
    expect(lines.find((l) => l.includes("external"))).toContain(
      "(set: ONECLI_EXTERNAL_URL)",
    );
    expect(lines.find((l) => l.includes("api "))).toContain("(derived)");
    expect(lines.find((l) => l.includes("agent proxy"))).toContain(
      "(alias: GATEWAY_BASE_URL)",
    );
  });
});

// ── env wrapper + facades ─────────────────────────────────────────────────

const ENV_KEYS = [
  "ONECLI_EXTERNAL_URL",
  "APP_URL",
  "NEXT_PUBLIC_APP_URL",
  "API_URL",
  "NEXT_PUBLIC_API_URL",
  "GATEWAY_API_URL",
  "NEXT_PUBLIC_GATEWAY_API_URL",
  "ONECLI_BIND_HOST",
  "ONECLI_APP_PORT",
  "ONECLI_API_PORT",
  "ONECLI_GATEWAY_PORT",
  "ONECLI_AGENT_PROXY_ADDRESS",
  "ONECLI_TRUSTED_ORIGINS",
  "GATEWAY_BASE_URL",
] as const;

describe("env wrapper and facades", () => {
  const orig: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) orig[key] = process.env[key];
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (orig[key] === undefined) delete process.env[key];
      else process.env[key] = orig[key];
    }
  });
  const clearAll = () => {
    for (const key of ENV_KEYS) delete process.env[key];
  };

  it("resolveOriginsFromEnv reads the process environment", () => {
    clearAll();
    process.env.ONECLI_EXTERNAL_URL = "https://env.example";
    expect(resolveOriginsFromEnv().gateway).toBe("https://env.example/gw");
  });

  // The load-bearing case: `undefined` is what lets call sites fall back to
  // the request origin. If this ever returned the resolver default instead,
  // every consumer would silently pin self-hosters to localhost again.
  it("configuredAppUrl is undefined when nothing is configured", () => {
    clearAll();
    expect(configuredAppUrl()).toBeUndefined();
  });

  it("configuredAppUrl answers for each head, legacy bind seed included", () => {
    clearAll();
    process.env.ONECLI_EXTERNAL_URL = "http://a.example:10254";
    expect(configuredAppUrl()).toBe("http://a.example:10254");
    clearAll();
    process.env.APP_URL = "http://b.example:10254";
    expect(configuredAppUrl()).toBe("http://b.example:10254");
    clearAll();
    process.env.ONECLI_BIND_HOST = "172.17.0.1";
    expect(configuredAppUrl()).toBe("http://172.17.0.1:10254");
  });

  it("configuredApiUrl is undefined when nothing is configured", () => {
    clearAll();
    expect(configuredApiUrl()).toBeUndefined();
  });

  it("configuredApiUrl answers API_URL when set", () => {
    clearAll();
    process.env.API_URL = "https://api.acme.com/";
    expect(configuredApiUrl()).toBe("https://api.acme.com");
  });

  // Frozen legacy semantics: APP_URL alone never answers for the api —
  // request-origin.test.ts pins the same fact one level up.
  it("configuredApiUrl stays undefined when only the APP_URL alias is set", () => {
    clearAll();
    process.env.APP_URL = "https://dashboard.example.com";
    expect(configuredApiUrl()).toBeUndefined();
  });

  // The required subtlety: a configured external URL makes the API origin
  // *derived-but-configured*, pinning OAuth redirect URIs and cookie-domain
  // inputs without a separate API_URL line.
  it("configuredApiUrl answers the derived origin when only the external URL is set", () => {
    clearAll();
    process.env.ONECLI_EXTERNAL_URL = "http://192.0.2.10:10254";
    expect(configuredApiUrl()).toBe("http://192.0.2.10:10256");
    process.env.ONECLI_EXTERNAL_URL = "https://onecli.acme.com";
    expect(configuredApiUrl()).toBe("https://onecli.acme.com");
  });
});

// The credentialed-CORS allow-list and the OAuth trusted-referer step both
// resolve through this. Fail-closed is the whole point: a `undefined` here
// means no `Access-Control-Allow-Origin` header, so an attacker's page cannot
// read an authenticated response (SameSite=lax does not cover it — it is
// site-scoped, so a sibling subdomain is same-site and sends the cookie).
describe("trustedBrowserOrigin", () => {
  const orig: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) orig[key] = process.env[key];
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (orig[key] === undefined) delete process.env[key];
      else process.env[key] = orig[key];
    }
  });
  const clearAll = () => {
    for (const key of ENV_KEYS) delete process.env[key];
  };

  it("echoes the configured app origin", () => {
    clearAll();
    process.env.ONECLI_EXTERNAL_URL = "https://onecli.acme.com";
    expect(trustedBrowserOrigin("https://onecli.acme.com")).toBe(
      "https://onecli.acme.com",
    );
  });

  it("refuses an arbitrary origin", () => {
    clearAll();
    process.env.ONECLI_EXTERNAL_URL = "https://onecli.acme.com";
    expect(trustedBrowserOrigin("https://evil.example")).toBeUndefined();
  });

  // Hono hands the callback "" when the request carries no Origin (a CLI, a
  // curl, a server-side caller); null/undefined arrive from other callers.
  it("refuses an absent, empty or null origin", () => {
    clearAll();
    expect(trustedBrowserOrigin(undefined)).toBeUndefined();
    expect(trustedBrowserOrigin("")).toBeUndefined();
    expect(trustedBrowserOrigin(null)).toBeUndefined();
  });

  it("refuses a malformed origin", () => {
    clearAll();
    expect(trustedBrowserOrigin("not-an-origin")).toBeUndefined();
    expect(trustedBrowserOrigin("javascript:alert(1)")).toBeUndefined();
  });

  // The classic allow-list bypass: a substring match would admit both.
  it("does not match on a host prefix or suffix", () => {
    clearAll();
    process.env.ONECLI_EXTERNAL_URL = "https://onecli.acme.com";
    expect(
      trustedBrowserOrigin("https://onecli.acme.com.evil.example"),
    ).toBeUndefined();
    expect(
      trustedBrowserOrigin("https://evil-onecli.acme.com"),
    ).toBeUndefined();
  });

  // A sibling subdomain is SAME-SITE, so the session cookie rides along on a
  // credentialed fetch. The allow-list is the only fence, and a shared cookie
  // domain (BETTER_AUTH_COOKIE_DOMAIN) does not widen it.
  it("refuses a sibling subdomain of the dashboard", () => {
    clearAll();
    process.env.ONECLI_EXTERNAL_URL = "https://onecli.acme.com";
    expect(trustedBrowserOrigin("https://blog.acme.com")).toBeUndefined();
  });

  // Same host, different port is same-site too — and not the dashboard.
  it("refuses another port on the dashboard's own host", () => {
    clearAll();
    process.env.ONECLI_EXTERNAL_URL = "http://192.0.2.10:10254";
    expect(trustedBrowserOrigin("http://192.0.2.10:9999")).toBeUndefined();
  });

  it("accepts an ONECLI_TRUSTED_ORIGINS extra", () => {
    clearAll();
    process.env.ONECLI_EXTERNAL_URL = "http://192.0.2.10:10254";
    process.env.ONECLI_TRUSTED_ORIGINS = "http://192.168.1.50:10254";
    expect(trustedBrowserOrigin("http://192.168.1.50:10254")).toBe(
      "http://192.168.1.50:10254",
    );
  });

  it("accepts the loopback twin of a zero-config install", () => {
    clearAll();
    expect(trustedBrowserOrigin("http://127.0.0.1:10254")).toBe(
      "http://127.0.0.1:10254",
    );
  });

  // The split-host shape: the dashboard calls an api on its own hostname, so
  // that origin has to be answerable too.
  it("accepts the configured split-host api origin", () => {
    clearAll();
    process.env.ONECLI_EXTERNAL_URL = "https://app.acme.com";
    process.env.API_URL = "https://api.acme.com";
    expect(trustedBrowserOrigin("https://api.acme.com")).toBe(
      "https://api.acme.com",
    );
  });

  // Trailing-slash and case differences are normalization, not new trust.
  it("normalizes before comparing", () => {
    clearAll();
    process.env.ONECLI_EXTERNAL_URL = "https://onecli.acme.com";
    expect(trustedBrowserOrigin("https://onecli.acme.com/")).toBe(
      "https://onecli.acme.com",
    );
    expect(trustedBrowserOrigin("HTTPS://onecli.acme.com")).toBe(
      "https://onecli.acme.com",
    );
  });

  // Env is read per call, never frozen at module load: the api-server builds
  // its CORS middleware once at import, so a cached set would pin whatever
  // the environment looked like then.
  it("reads the environment per call", () => {
    clearAll();
    process.env.ONECLI_EXTERNAL_URL = "https://first.example";
    expect(trustedBrowserOrigin("https://second.example")).toBeUndefined();
    process.env.ONECLI_EXTERNAL_URL = "https://second.example";
    expect(trustedBrowserOrigin("https://second.example")).toBe(
      "https://second.example",
    );
  });
});

// Next.js inlines NEXT_PUBLIC_* into client bundles only as literal
// `process.env.X` member expressions, and the hermetic-env scanner classifies
// only dot reads — pin that the source keeps them literal.
describe("source form", () => {
  it("keeps literal dot reads for the inlineable NEXT_PUBLIC vars", () => {
    const source = readFileSync(join(__dirname, "public-origins.ts"), "utf8");
    for (const name of [
      "NEXT_PUBLIC_APP_URL",
      "NEXT_PUBLIC_API_URL",
      "NEXT_PUBLIC_GATEWAY_API_URL",
    ]) {
      expect(source).toContain(`process.env.${name}`);
    }
    expect(source).not.toMatch(/process\.env\[/);
  });
});
