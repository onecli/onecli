import { describe, expect, it } from "vitest";
import { resolveCookieDomain } from "./cookie-domain";

// Pure and argument-driven on purpose: every rule here decides the scope of a
// bearer credential, and the failure modes are silent (a Domain browsers
// reject is simply never sent back — login "doesn't stick" with nothing in
// any log). No env stubbing, no ambient APP_URL from the developer's shell.

describe("resolveCookieDomain — automatic derivation", () => {
  it("spans the shared parent of sibling subdomains", () => {
    const resolved = resolveCookieDomain({
      appUrl: "https://onecli.example.com",
      apiUrl: "https://api.onecli.example.com",
    });
    expect(resolved).toMatchObject({
      kind: "shared",
      domain: "onecli.example.com",
      source: "derived",
    });
  });

  it("picks the MOST SPECIFIC shared parent, not the registrable root", () => {
    // Upstream guidance: scope the cookie as narrowly as possible.
    const resolved = resolveCookieDomain({
      appUrl: "https://app.eu.example.com",
      apiUrl: "https://api.eu.example.com",
    });
    expect(resolved).toMatchObject({
      kind: "shared",
      domain: "eu.example.com",
    });
  });

  it("compares hosts label-wise, never as character suffixes", () => {
    // A char-suffix implementation would yield "app.example.com" here.
    const resolved = resolveCookieDomain({
      appUrl: "https://app.example.com",
      apiUrl: "https://myapp.example.com",
    });
    expect(resolved).toMatchObject({ kind: "shared", domain: "example.com" });
  });

  it("refuses hosts under a PRIVATE public suffix (the ngrok trap)", () => {
    // tldts' default profile calls "a.ngrok-free.app" registrable; browsers
    // honour the PSL's private section and would silently drop the cookie.
    // Two tunnels can never share a session — the resolver must say so.
    const resolved = resolveCookieDomain({
      appUrl: "https://web-abc.ngrok-free.app",
      apiUrl: "https://api-def.ngrok-free.app",
    });
    expect(resolved).toMatchObject({ kind: "host-only", reason: "cross-site" });
  });

  it("refuses unrelated registrable domains", () => {
    const resolved = resolveCookieDomain({
      appUrl: "https://onecli.example.com",
      apiUrl: "https://api.other.io",
    });
    expect(resolved).toMatchObject({ kind: "host-only", reason: "cross-site" });
  });

  it.each([
    ["localhost", "http://localhost:10254", "http://api.localhost:10256"],
    ["IPv4 literals", "http://192.168.1.10:10254", "http://192.168.1.11:10256"],
    ["bracketed IPv6", "http://[::1]:10254", "http://[fe80::1]:10256"],
  ])("never builds a domain from %s", (_label, appUrl, apiUrl) => {
    expect(resolveCookieDomain({ appUrl, apiUrl })).toMatchObject({
      kind: "host-only",
      reason: "cross-site",
    });
  });

  it("stays host-only when both URLs share a hostname (stock deploy)", () => {
    const resolved = resolveCookieDomain({
      appUrl: "http://my-selfhost-box:10254",
      apiUrl: "http://my-selfhost-box:10256",
    });
    expect(resolved).toMatchObject({ kind: "host-only", reason: "same-host" });
  });

  it("stays host-only when either URL is unconfigured", () => {
    expect(
      resolveCookieDomain({ appUrl: "https://onecli.example.com" }),
    ).toMatchObject({ kind: "host-only", reason: "unconfigured" });
    expect(
      resolveCookieDomain({ apiUrl: "https://api.onecli.example.com" }),
    ).toMatchObject({ kind: "host-only", reason: "unconfigured" });
    expect(resolveCookieDomain({})).toMatchObject({
      kind: "host-only",
      reason: "unconfigured",
    });
  });

  it("treats an unparseable URL as unconfigured, with a warning", () => {
    const resolved = resolveCookieDomain({
      appUrl: "onecli.example.com", // no scheme — new URL() throws
      apiUrl: "https://api.onecli.example.com",
    });
    expect(resolved).toMatchObject({
      kind: "host-only",
      reason: "unconfigured",
    });
    expect(resolved.warnings.join(" ")).toMatch(/APP_URL is not a parseable/);
  });

  it("normalizes trailing-dot and uppercase hostnames before comparing", () => {
    const resolved = resolveCookieDomain({
      appUrl: "https://ONECLI.Example.COM.",
      apiUrl: "https://api.onecli.example.com",
    });
    expect(resolved).toMatchObject({
      kind: "shared",
      domain: "onecli.example.com",
    });
  });

  it("warns that an apex-derived domain reaches every subdomain", () => {
    // Dashboard on the apex + API on a subdomain: the shared parent IS the
    // registrable root example.com, so the cookie reaches every subdomain of
    // it (status.example.com, www.example.com…) — worth flagging.
    const resolved = resolveCookieDomain({
      appUrl: "https://example.com",
      apiUrl: "https://api.example.com",
    });
    expect(resolved).toMatchObject({ kind: "shared", domain: "example.com" });
    expect(resolved.warnings.join(" ")).toMatch(/EVERY subdomain/);
  });

  it("does NOT warn about subdomain reach when the shared parent is narrower", () => {
    const resolved = resolveCookieDomain({
      appUrl: "https://app.eu.example.com",
      apiUrl: "https://api.eu.example.com",
    });
    expect(resolved.kind).toBe("shared");
    expect(resolved.warnings.join(" ")).not.toMatch(/EVERY subdomain/);
  });

  it("warns when an https API pairs with an http dashboard", () => {
    // useSecureCookies follows the API's scheme: the cookie comes out
    // `__Secure-` and browsers refuse to send it over plain http, so the
    // shared domain cannot rescue this config — a login that never sticks.
    const resolved = resolveCookieDomain({
      appUrl: "http://onecli.example.com",
      apiUrl: "https://api.onecli.example.com",
    });
    expect(resolved.kind).toBe("shared");
    expect(resolved.warnings.join(" ")).toMatch(/Secure/);
  });
});

describe("resolveCookieDomain — BETTER_AUTH_COOKIE_DOMAIN override", () => {
  it("pins the domain verbatim after normalization", () => {
    const resolved = resolveCookieDomain({
      override: " .Onecli.Example.com. ",
      appUrl: "https://onecli.example.com",
      apiUrl: "https://api.onecli.example.com",
    });
    expect(resolved).toMatchObject({
      kind: "shared",
      domain: "onecli.example.com",
      source: "override",
      warnings: [],
    });
  });

  it("wins over automatic derivation", () => {
    // Auto would pick eu.example.com; the operator widens deliberately.
    const resolved = resolveCookieDomain({
      override: "example.com",
      appUrl: "https://app.eu.example.com",
      apiUrl: "https://api.eu.example.com",
    });
    expect(resolved).toMatchObject({ kind: "shared", domain: "example.com" });
  });

  it("'none' opts out of sharing entirely", () => {
    const resolved = resolveCookieDomain({
      override: "NONE",
      appUrl: "https://onecli.example.com",
      apiUrl: "https://api.onecli.example.com",
    });
    expect(resolved).toMatchObject({ kind: "host-only", reason: "opt-out" });
  });

  it.each([
    ["a full URL", "https://example.com"],
    ["a host:port", "example.com:443"],
    ["userinfo", "user@example.com"],
    ["a path", "example.com/callback"],
    ["embedded whitespace", "exa mple.com"],
  ])(
    "rejects URL/authority-shaped override %s and falls back to derivation",
    (_label, override) => {
      // A Domain attribute is a bare host; anything else makes the browser
      // drop the whole cookie, so these must fall back rather than ship.
      const resolved = resolveCookieDomain({
        override,
        appUrl: "https://onecli.example.com",
        apiUrl: "https://api.onecli.example.com",
      });
      expect(resolved).toMatchObject({
        kind: "shared",
        domain: "onecli.example.com",
        source: "derived",
      });
      expect(resolved.warnings.join(" ")).toMatch(/BETTER_AUTH_COOKIE_DOMAIN/);
    },
  );

  it("IDNA-encodes a unicode override so it never reaches Set-Cookie raw", () => {
    // URL.hostname punycodes it; a raw-unicode Domain would 500 the serializer.
    const resolved = resolveCookieDomain({
      override: "münchen.example.com",
      appUrl: "https://a.münchen.example.com",
      apiUrl: "https://b.münchen.example.com",
    });
    expect(resolved).toMatchObject({
      kind: "shared",
      domain: "xn--mnchen-3ya.example.com",
      source: "override",
    });
  });

  it.each([
    ["a bare public suffix", "com"],
    ["a private public suffix", "ngrok-free.app"],
    ["an IP address", "192.168.1.1"],
    ["a single label", "intranet"],
  ])("rejects %s and falls back to derivation", (_label, override) => {
    const resolved = resolveCookieDomain({
      override,
      appUrl: "https://onecli.example.com",
      apiUrl: "https://api.onecli.example.com",
    });
    // Fallback still derives the right answer — and says why the override lost.
    expect(resolved).toMatchObject({
      kind: "shared",
      domain: "onecli.example.com",
      source: "derived",
    });
    expect(resolved.warnings.join(" ")).toMatch(/BETTER_AUTH_COOKIE_DOMAIN/);
  });

  it("warns when the override does not cover a configured host", () => {
    const resolved = resolveCookieDomain({
      override: "other.io",
      appUrl: "https://onecli.example.com",
      apiUrl: "https://api.onecli.example.com",
    });
    expect(resolved).toMatchObject({
      kind: "shared",
      domain: "other.io",
      source: "override",
    });
    expect(resolved.warnings.join(" ")).toMatch(/does not cover/);
    expect(resolved.warnings).toHaveLength(2); // neither host is covered
  });

  it("does not mistake a label-suffix for a char-suffix when validating coverage", () => {
    const resolved = resolveCookieDomain({
      override: "example.com",
      appUrl: "https://notexample.com",
      apiUrl: "https://api.example.com",
    });
    expect(resolved.warnings.join(" ")).toMatch(/APP_URL host notexample\.com/);
  });
});
