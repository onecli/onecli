import { readdirSync, statSync } from "node:fs";
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
