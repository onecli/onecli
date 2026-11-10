// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  REDIRECT_ONLY_ROUTES,
  isAccountPath,
  isRedirectOnlyPath,
} from "./redirect-only-routes";

/**
 * `REDIRECT_ONLY_ROUTES` must name exactly the dashboard pages that only
 * redirect. Read from the route tree itself: a page whose default export
 * renders nothing (no JSX anywhere in the page or the module it re-exports)
 * and calls a redirect is a redirect-only page. A new redirect page missing
 * from the list would draw an empty shell on cloud while it forwards; a page
 * on the list that starts rendering would hide behind the skeleton.
 */

const SRC = join(import.meta.dirname, "..", "..");
const DASHBOARD = join(SRC, "app", "(dashboard)");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

/** The module a page's source points at with `export { default } from`. */
const reExportTarget = (file: string, source: string): string | null => {
  const match = source.match(/export\s*\{\s*default[^}]*\}\s*from\s*"([^"]+)"/);
  if (!match?.[1]) return null;
  const spec = match[1];
  const base = spec.startsWith("@/")
    ? join(SRC, spec.slice(2))
    : resolve(join(file, ".."), spec);
  for (const candidate of [
    `${base}.tsx`,
    `${base}.ts`,
    join(base, "index.tsx"),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not this one
    }
  }
  throw new Error(`cannot resolve ${spec} from ${file}`);
};

const REDIRECTS = new Set([
  "redirect",
  "permanentRedirect",
  "redirectToSettingsModal",
  "redirectMergedSection",
]);

/** Whether a module renders no JSX and calls a redirect helper. */
const onlyRedirects = (file: string): boolean => {
  const source = readFileSync(file, "utf8");
  const target = reExportTarget(file, source);
  if (target) return onlyRedirects(target);
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let jsx = false;
  let redirects = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxFragment(node)
    ) {
      jsx = true;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      REDIRECTS.has(node.expression.text)
    ) {
      redirects = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return redirects && !jsx;
};

/** A page file's URL pattern: route groups dropped, a dynamic segment `*`. */
const routeOf = (pageFile: string): string =>
  `/${relative(DASHBOARD, join(pageFile, ".."))
    .split(sep)
    .filter((s) => s !== "" && !/^\(.*\)$/.test(s))
    .map((s) => (/^\[.*\]$/.test(s) ? "*" : s))
    .join("/")}`.replace(/\/$/, "") || "/";

const pages = walk(DASHBOARD).filter(
  (f) => f.endsWith(`${sep}page.tsx`) && !f.includes(`${sep}@settings${sep}`),
);

describe("REDIRECT_ONLY_ROUTES", () => {
  it("names exactly the dashboard pages that only redirect", () => {
    const onDisk = pages.filter(onlyRedirects).map(routeOf).sort();
    expect([...REDIRECT_ONLY_ROUTES].sort()).toEqual(onDisk);
  });

  it("leaves out every page that renders something", () => {
    const rendering = pages.filter((f) => !onlyRedirects(f)).map(routeOf);
    expect(rendering.length).toBeGreaterThan(10);
    for (const route of rendering) {
      const sample = route.replaceAll("*", "x1");
      expect(isRedirectOnlyPath(sample), route).toBe(false);
    }
  });
});

describe("isRedirectOnlyPath", () => {
  it("matches each old address with real ids in it", () => {
    for (const route of REDIRECT_ONLY_ROUTES) {
      expect(isRedirectOnlyPath(route.replaceAll("*", "abc123")), route).toBe(
        true,
      );
    }
  });

  it("matches an old address with a trailing slash", () => {
    expect(isRedirectOnlyPath("/org/o1/team/")).toBe(true);
  });

  it("does not match the pages the old addresses forward to", () => {
    for (const path of [
      "/",
      "/w/w1/agents",
      "/w/w1/agents/a1",
      "/w/w1/agents/a1/chat",
      "/w/w1/agents/a1/knowledge",
      "/w/w1/agents/a1/settings",
      "/w/w1/agents/a1/contacts",
      "/w/w1/agents/a1/connections",
      "/w/w1/settings/install",
      "/w/w1/files/f1",
      "/org/o1/workspaces",
      "/org/o1/skills",
    ]) {
      expect(isRedirectOnlyPath(path), path).toBe(false);
    }
  });

  it("does not match deeper paths under an old address", () => {
    expect(isRedirectOnlyPath("/org/o1/team/extra")).toBe(false);
    expect(isRedirectOnlyPath("/w/w1/agents/a1/memory/m1")).toBe(false);
  });
});

// The account's pages render for a viewer with no org, so they are not
// redirect-only (the route-tree check above keeps them off that list);
// `isAccountPath` names them for the layout, which asks the session.
describe("isAccountPath", () => {
  it("matches every page under /account", () => {
    const onDisk = pages
      .map(routeOf)
      .filter((route) => route === "/account" || route.startsWith("/account/"));
    expect(onDisk.length).toBeGreaterThanOrEqual(4);
    for (const route of onDisk) expect(isAccountPath(route), route).toBe(true);
  });

  it("matches nothing else, not even a lookalike prefix", () => {
    for (const path of ["/", "/accounts", "/account-x", "/org/o1/account"]) {
      expect(isAccountPath(path), path).toBe(false);
    }
  });
});
