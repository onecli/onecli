import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { MERGED_AGENT_SECTIONS } from "./navigation";
import type { OrgPage, WorkspacePage } from "./navigation";

/**
 * Two guards that keep `lib/navigation.ts` the only place a dashboard URL is
 * spelled out, so a page can move by editing a
 * builder rather than hunting template literals:
 *
 * 1. No source file builds a `/w/<id>` or `/org/<id>` URL by hand. The
 *    builders exist for that; a new literal is a link the next move strands.
 * 2. The builders' page unions match the route tree, both ways: a page in
 *    the union that no longer exists is a dead link the type system would
 *    otherwise keep accepting, and a page in the tree the union lacks is a
 *    page the next move cannot see.
 */

const SRC = join(import.meta.dirname, "..");
const APP = join(SRC, "app", "(dashboard)");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

describe("hand-built dashboard URLs", () => {
  it("live only in lib/navigation.ts", () => {
    const offenders = walk(SRC)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => relative(SRC, f) !== join("lib", "navigation.ts"))
      .flatMap((f) => {
        const lines = readFileSync(f, "utf8").split("\n");
        return lines.flatMap((line, i) =>
          /[`"']\/(w|org)\/\$\{/.test(line)
            ? [`${relative(SRC, f)}:${i + 1}: ${line.trim()}`]
            : [],
        );
      });
    expect(offenders).toEqual([]);
  });
});

/** Route-group dirs `(admin)` and `(tabs)` do not appear in the URL. */
const urlOf = (dir: string, root: string): string =>
  relative(root, dir)
    .split(sep)
    .filter((s) => !/^\(.*\)$/.test(s))
    .join("/");

/** Every page directly under `root` whose URL has no dynamic segment:
 *  the pages a closed union can name. */
const staticPages = (root: string): string[] =>
  walk(root)
    .filter((f) => f.endsWith(`${sep}page.tsx`))
    .map((f) => urlOf(join(f, ".."), root))
    .filter((u) => !u.includes("["))
    .sort();

// A union's members, spelled out ONCE here and checked against the tree.
// `satisfies` keeps this list from drifting from the type; the test keeps
// the type from drifting from the tree.
const ORG_PAGES = [
  "",
  "workspaces",
  "team",
  "groups",
  "usage",
  "billing",
  "channels",
  "skills",
  "settings",
  "settings/general",
  "settings/sso",
  "settings/app-availability",
  "settings/global-connections",
  "settings/policy",
  "settings/org-api-keys",
  "settings/channels",
] as const satisfies readonly OrgPage[];

const WORKSPACE_PAGES = [
  "",
  "agents",
  "activity",
  "connections",
  "files",
  "overview",
  "skills",
  "settings",
  "settings/general",
  "settings/install",
  "settings/api-key",
] as const satisfies readonly WorkspacePage[];

// The pages under org and workspace roots that the unions deliberately
// omit, with the reason. A page here is reachable only through its own
// surface (tabs within a section), never as a top-level link target.
const NOT_LINKED_ORG = new Set([
  // Shared Connections tabs: `connectionsPath` builds these from the root.
  "settings/global-connections/connected",
  "settings/global-connections/custom",
  "settings/global-connections/llms",
  "settings/global-connections/apps",
  // A redirect kept for old links; nothing links TO it.
  "app-availability",
]);
const NOT_LINKED_WORKSPACE = new Set([
  // Connections tabs and vault pages: `connectionsPath` builds these.
  "connections/connected",
  "connections/custom",
  "connections/llms",
  "connections/secrets",
  "connections/vaults",
  "connections/apps",
  "connections/vaults/bitwarden",
  "connections/vaults/onepassword",
]);

describe("route builder unions", () => {
  it("OrgPage names exactly the static pages under /org/[orgId]", () => {
    const tree = staticPages(join(APP, "org", "[orgId]")).filter(
      (u) => !NOT_LINKED_ORG.has(u),
    );
    expect([...ORG_PAGES].sort()).toEqual(tree);
  });

  it("WorkspacePage names exactly the static pages under /w/[workspaceId]", () => {
    const tree = staticPages(join(APP, "w", "[workspaceId]")).filter(
      (u) => !NOT_LINKED_WORKSPACE.has(u),
    );
    expect([...WORKSPACE_PAGES].sort()).toEqual(tree);
  });

  it("the not-linked lists name only pages that exist", () => {
    const org = new Set(staticPages(join(APP, "org", "[orgId]")));
    const ws = new Set(staticPages(join(APP, "w", "[workspaceId]")));
    expect([...NOT_LINKED_ORG].filter((u) => !org.has(u))).toEqual([]);
    expect([...NOT_LINKED_WORKSPACE].filter((u) => !ws.has(u))).toEqual([]);
  });
});

// A merged agent section's link lands on `<page>#<anchor>`. The anchor is an
// element id somewhere in that page's directory: rename the block and every
// deep link (the chat's "Open skills", the bell's "Fix in Slack", the
// install return) would land at the top of the page instead.
describe("merged agent sections", () => {
  const AGENT = join(APP, "w", "[workspaceId]", "agents", "[agentId]");

  it.each(
    Object.entries(MERGED_AGENT_SECTIONS).flatMap(([old, { page, anchor }]) =>
      anchor ? [[old, page, anchor] as const] : [],
    ),
  )("%s lands on a block its page draws", (_old, page, anchor) => {
    const source = walk(join(AGENT, page))
      .filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    expect(source).toMatch(new RegExp(`id="${anchor}"`));
  });

  it("each old section still has its redirect page", () => {
    for (const old of Object.keys(MERGED_AGENT_SECTIONS)) {
      expect(statSync(join(AGENT, old, "page.tsx")).isFile()).toBe(true);
    }
  });
});
