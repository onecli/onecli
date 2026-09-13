import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHANNEL_PROVIDER_IDS } from "./errors";

/**
 * The package's own structural law: one directory per provider, each named
 * by an id in `CHANNEL_PROVIDER_IDS`, each exported as a subpath. This is
 * what makes "add Teams" a checklist instead of an archaeology project —
 * and this suite is the checklist's enforcement:
 *
 *   - a provider directory with no id in the union is dead code (or a typo);
 *   - an id with no directory is a registry entry that can never resolve;
 *   - a provider directory missing from `exports` is unreachable by either
 *     runtime (the failure mode is a deep-import workaround, which then
 *     bypasses the package boundary).
 *
 * The GENERIC layer's law rides here too: nothing outside `src/<provider>/`
 * may name a concrete provider. The day this fails is the day a Slack-ism
 * leaked into the shared surface - the exact drift this package exists to
 * prevent.
 */
describe("the provider directory contract", () => {
  const src = __dirname;
  const providerDirs = readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  it("every provider directory is a declared provider id, and vice versa", () => {
    expect([...providerDirs].sort()).toEqual([...CHANNEL_PROVIDER_IDS].sort());
  });

  it("every provider is reachable as a subpath export", () => {
    const pkg = JSON.parse(
      readFileSync(join(src, "..", "package.json"), "utf8"),
    ) as { exports: Record<string, string> };
    for (const id of CHANNEL_PROVIDER_IDS) {
      expect(pkg.exports[`./${id}`]).toBe(`./src/${id}/index.ts`);
    }
  });

  it("the generic layer names no concrete provider", () => {
    for (const file of readdirSync(src)) {
      if (!file.endsWith(".ts") || file === "provider-shape.test.ts") continue;
      const source = readFileSync(join(src, file), "utf8");
      // Strip comments/docs: the union DECLARES ids and errors.ts documents
      // them - prose may name providers, code paths may not.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      for (const id of CHANNEL_PROVIDER_IDS) {
        const mentions = code.split(`"${id}"`).length - 1;
        // errors.ts holds exactly one mention: the union literal itself.
        const allowed = file === "errors.ts" ? 1 : 0;
        expect(
          mentions,
          `${file} names "${id}" ${mentions}x (allowed: ${allowed})`,
        ).toBeLessThanOrEqual(allowed);
      }
    }
  });
});
