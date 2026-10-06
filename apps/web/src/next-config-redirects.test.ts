import { describe, expect, it } from "vitest";
import config from "../next.config.js";

// Org-wide administration moved under Organization Settings (Global
// Connections, Global Policy) and Domains folded into the Single sign-on
// page. Every old URL must keep landing: bookmarks, links pasted into docs
// and chat, and the deep links INSIDE the moved trees (a Global Connections
// tab, an app's page), not only the section roots.

interface Redirect {
  source: string;
  destination: string;
  permanent: boolean;
}

const redirects = async (): Promise<Redirect[]> => {
  const fn = (config as { redirects?: () => Promise<Redirect[]> }).redirects;
  if (!fn) throw new Error("next.config.js lost its redirects()");
  return fn();
};

/** Apply the FIRST matching rule, the way Next.js does. Supports the two
 *  param forms the rules use: `:name` (one segment) and `:name*` (zero or
 *  more trailing segments). */
const resolve = (rules: Redirect[], path: string): string | null => {
  for (const rule of rules) {
    const names: string[] = [];
    const pattern = rule.source.replace(
      /\/:(\w+)(\*)?/g,
      (_match, name: string, star?: string) => {
        names.push(name);
        return star ? "(?:/(.*))?" : "/([^/]+)";
      },
    );
    const match = new RegExp(`^${pattern}$`).exec(path);
    if (!match) continue;
    let destination = rule.destination;
    names.forEach((name, i) => {
      const value = match[i + 1] ?? "";
      destination = destination.replace(
        new RegExp(`/:${name}\\*?`),
        value ? `/${value}` : "",
      );
    });
    return destination;
  }
  return null;
};

describe("moved org settings routes redirect", () => {
  it.each([
    ["/org/o1/global-connections", "/org/o1/settings/global-connections"],
    [
      "/org/o1/global-connections/custom",
      "/org/o1/settings/global-connections/custom",
    ],
    [
      "/org/o1/global-connections/llms",
      "/org/o1/settings/global-connections/llms",
    ],
    [
      "/org/o1/global-connections/connected",
      "/org/o1/settings/global-connections/connected",
    ],
    [
      "/org/o1/global-connections/apps/github",
      "/org/o1/settings/global-connections/apps/github",
    ],
    ["/org/o1/policy", "/org/o1/settings/policy"],
    ["/org/o1/settings/domains", "/org/o1/settings/sso"],
  ])("%s -> %s", async (from, to) => {
    expect(resolve(await redirects(), from)).toBe(to);
  });

  it("never captures the NEW locations (no redirect loop)", async () => {
    const rules = await redirects();
    expect(resolve(rules, "/org/o1/settings/global-connections")).toBeNull();
    expect(
      resolve(rules, "/org/o1/settings/global-connections/apps/github"),
    ).toBeNull();
    expect(resolve(rules, "/org/o1/settings/policy")).toBeNull();
    expect(resolve(rules, "/org/o1/settings/sso")).toBeNull();
  });

  it("is temporary: the settings layout may move again", async () => {
    const moved = (await redirects()).filter((rule) =>
      rule.source.startsWith("/org/"),
    );
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.every((rule) => rule.permanent === false)).toBe(true);
  });
});
