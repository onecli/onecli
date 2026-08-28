import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WEB_AUTH_PAGES } from "./proxy";

/**
 * `WEB_AUTH_PAGES` decides which `/auth/*` paths keep the setup-error
 * redirect (the dashboard's own pages) versus fall through to the dev proxy
 * as API surface. It is a hand-maintained mirror of the filesystem router, so
 * this test walks `src/app/auth` and fails when the two drift — a new
 * `/auth/<page>` added without updating the list would silently lose its
 * setup gate.
 */

const collectPageRoutes = (dir: string, route: string): string[] => {
  const routes: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) {
      if (entry === "page.tsx") routes.push(route);
      continue;
    }
    routes.push(...collectPageRoutes(full, `${route}/${entry}`));
  }
  return routes;
};

describe("WEB_AUTH_PAGES", () => {
  it("covers exactly the /auth pages the filesystem router serves", () => {
    const pages = collectPageRoutes(join(__dirname, "app", "auth"), "/auth");

    for (const page of pages) {
      expect(
        WEB_AUTH_PAGES.some(
          (listed) => page === listed || page.startsWith(`${listed}/`),
        ),
        `${page} is served by the app router but not covered by ` +
          "WEB_AUTH_PAGES in proxy.ts — it would skip the setup-error gate",
      ).toBe(true);
    }

    for (const listed of WEB_AUTH_PAGES) {
      expect(
        pages.some((page) => page === listed || page.startsWith(`${listed}/`)),
        `${listed} is in WEB_AUTH_PAGES but no page exists under it — ` +
          "remove it or the dev proxy will never forward that path",
      ).toBe(true);
    }
  });
});

// Source-as-assertion pins for the cloud CSP (OC-01). `IS_CLOUD` is baked at
// module load, so the load-bearing wiring is pinned on source, layout-
// injection style; the policy CONTENT is unit-tested in lib/csp.test.ts.
describe("cloud nonce CSP wiring", () => {
  const source = readFileSync(join(__dirname, "proxy.ts"), "utf8");

  it("is cloud-gated — onprem responses stay CSP-free", () => {
    expect(source).toMatch(/if \(IS_CLOUD\) \{\s*\n\s*const nonce/);
  });

  it("sets the CSP on the FORWARDED REQUEST — what makes Next nonce its scripts", () => {
    expect(source).toContain(
      'requestHeaders.set("content-security-policy", csp)',
    );
  });

  it("mirrors the same CSP onto the response the browser enforces", () => {
    expect(source).toContain(
      'response.headers.set("content-security-policy", csp)',
    );
  });

  it("hands the nonce to server components via x-nonce", () => {
    expect(source).toContain('requestHeaders.set("x-nonce", nonce)');
  });

  it("strips any client-supplied x-nonce before minting its own", () => {
    const strip = source.indexOf('requestHeaders.delete("x-nonce")');
    const mint = source.indexOf('requestHeaders.set("x-nonce", nonce)');
    expect(strip).toBeGreaterThan(-1);
    expect(strip).toBeLessThan(mint);
  });
});
