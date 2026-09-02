import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCsp, createCspNonce } from "./csp";

/**
 * OC-01 pins: script-src must never regress back to 'unsafe-inline' /
 * 'unsafe-eval' in production, and the rest of the policy must keep the
 * hardened shape the retired CloudFront header had.
 */

const directives = (csp: string): Map<string, string> => {
  const map = new Map<string, string>();
  for (const part of csp.split("; ")) {
    const [name = "", ...rest] = part.split(" ");
    map.set(name, rest.join(" "));
  }
  return map;
};

describe("createCspNonce", () => {
  it("returns base64 and never repeats", () => {
    const a = createCspNonce();
    const b = createCspNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(a).not.toBe(b);
    // 16 random bytes -> 24 base64 chars.
    expect(a).toHaveLength(24);
  });
});

describe("buildCsp", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.onecli.sh");
    vi.stubEnv("NEXT_PUBLIC_GATEWAY_API_URL", "https://api.onecli.sh");
    vi.stubEnv("COGNITO_DOMAIN", "auth.onecli.sh");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("production script-src: nonce + strict-dynamic, NO unsafe-inline/unsafe-eval", () => {
    const csp = buildCsp("abc123");
    const scriptSrc = directives(csp).get("script-src")!;

    expect(scriptSrc).toContain("'nonce-abc123'");
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
  });

  it("keeps the third-party script hosts as the CSP2 fallback", () => {
    const scriptSrc = directives(buildCsp("n")).get("script-src")!;
    for (const host of [
      "https://js.stripe.com",
      "https://t.1cli.sh",
      "https://cdn.usefathom.com",
    ]) {
      expect(scriptSrc).toContain(host);
    }
  });

  it("dev adds unsafe-eval only (React server-stack debugging)", () => {
    vi.stubEnv("NODE_ENV", "development");
    const scriptSrc = directives(buildCsp("n")).get("script-src")!;
    expect(scriptSrc).toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("unsafe-inline");
  });

  it("matches the retired CloudFront policy on every other directive", () => {
    const map = directives(buildCsp("n"));

    expect(map.get("default-src")).toBe("'self'");
    expect(map.get("style-src")).toBe(
      "'self' 'unsafe-inline' https://fonts.googleapis.com",
    );
    expect(map.get("font-src")).toBe("'self' https://fonts.gstatic.com");
    expect(map.get("img-src")).toBe("'self' data: blob: https:");
    expect(map.get("frame-src")).toBe("https://js.stripe.com");
    expect(map.get("frame-ancestors")).toBe("'none'");
    expect(map.get("base-uri")).toBe("'self'");
    expect(map.get("form-action")).toBe("'self'");
    expect(map.get("object-src")).toBe("'none'");
  });

  it("connect-src carries the resolved api/auth origins + the fixed hosts", () => {
    const connectSrc = directives(buildCsp("n")).get("connect-src")!;
    for (const host of [
      "'self'",
      "https://api.onecli.sh",
      "https://auth.onecli.sh",
      "https://*.amazoncognito.com",
      "https://*.auth.us-east-1.amazoncognito.com",
      "https://cognito-idp.us-east-1.amazonaws.com",
      "https://api.stripe.com",
      "https://t.1cli.sh",
      "https://cdn.usefathom.com",
    ]) {
      expect(connectSrc).toContain(host);
    }
    // api and gateway share an origin in cloud — deduped, not repeated.
    expect(connectSrc.match(/https:\/\/api\.onecli\.sh/g)).toHaveLength(1);
  });

  it("omits the auth host cleanly when no Cognito domain is configured", () => {
    vi.stubEnv("COGNITO_DOMAIN", "");
    vi.stubEnv("NEXT_PUBLIC_COGNITO_DOMAIN", "");
    const connectSrc = directives(buildCsp("n")).get("connect-src")!;
    expect(connectSrc).not.toContain("https://auth.onecli.sh");
    expect(connectSrc).not.toMatch(/https:\/\/\s/);
  });
});
