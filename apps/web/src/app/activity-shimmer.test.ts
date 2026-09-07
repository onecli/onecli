// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

/**
 * The chat activity line's shimmer must survive Tailwind compilation.
 *
 * The regression this pins: `motion-safe:animate-shimmer` once pointed at a
 * hand-written `.animate-shimmer` class in this directory's plain globals.css.
 * Tailwind only applies variants to utilities it owns, so it silently emitted
 * NOTHING for the class — while the neighboring `bg-clip-text
 * text-transparent` DID compile, leaving every live caption ("Thinking…",
 * "Waking the agent…", the agent's narration) painted as a permanently
 * frozen gradient.
 *
 * The guard compiles the real Tailwind entry point (the UI package's
 * globals.css — the one file where `@theme` works) and asserts the classes
 * ActivityLine wears produce real rules. It fails on both ways this can
 * break: the token leaving the entry point, or a rename that orphans the
 * class in the markup.
 */

const ENTRY = path.resolve(
  import.meta.dirname,
  "../../../../packages/ui/src/styles/globals.css",
);

/** Resolve a CSS `@import` the way Tailwind's bundler integration would:
 *  relative ids as files, bare package ids through the package's `style`
 *  export (how tw-animate-css publishes) — `require.resolve` can't stand in
 *  because it ignores the `style` condition. */
const resolveCss = (id: string, base: string): string => {
  if (id.startsWith(".")) return path.resolve(base, id);
  for (let dir = base; ; dir = path.dirname(dir)) {
    const pkgPath = path.join(dir, "node_modules", id, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        style?: string;
        main?: string;
        exports?: { "."?: { style?: string } };
      };
      const entry =
        pkg.style ?? pkg.exports?.["."]?.style ?? pkg.main ?? "index.css";
      return path.resolve(path.dirname(pkgPath), entry);
    } catch {
      if (dir === path.dirname(dir))
        throw new Error(`cannot resolve CSS import "${id}" from ${base}`);
    }
  }
};

const compileClasses = async (candidates: string[]): Promise<string> => {
  const compiler = await compile(readFileSync(ENTRY, "utf8"), {
    base: path.dirname(ENTRY),
    loadStylesheet: async (id, base) => {
      const resolved = resolveCss(id, base);
      return {
        path: resolved,
        base: path.dirname(resolved),
        content: readFileSync(resolved, "utf8"),
      };
    },
  });
  return compiler.build(candidates);
};

describe("activity shimmer CSS", () => {
  it("emits a real rule for motion-safe:animate-shimmer, with its keyframes", async () => {
    const css = await compileClasses(["motion-safe:animate-shimmer"]);
    // The variant-wrapped utility must produce an animation declaration…
    expect(css).toMatch(/\.motion-safe\\:animate-shimmer\s*\{[^}]*animation:/);
    // …gated behind the reduced-motion media query…
    expect(css).toContain("@media (prefers-reduced-motion: no-preference)");
    // …and the keyframes it references must ride along.
    expect(css).toContain("@keyframes activity-shimmer");
  });

  it("keeps the markup and the theme token in the same name", async () => {
    // If someone renames the token (or the class) the compile above would
    // still pass for a stale candidate list — read the component and compile
    // the exact classes it actually wears today.
    const componentPath = path.resolve(
      import.meta.dirname,
      "(dashboard)/w/[workspaceId]/agents/[agentId]/chat/_components/activity-line.tsx",
    );
    const source = readFileSync(componentPath, "utf8");
    const classes = [...source.matchAll(/className="([^"]+)"/g)].flatMap(
      ([, list]) => list!.split(/\s+/),
    );
    const animated = classes.filter((c) => c.includes("animate-"));
    expect(animated).toContain("motion-safe:animate-shimmer");
    const css = await compileClasses(animated);
    // Every animate-* class in the component must land in the output —
    // Tailwind emitting nothing for one of them is exactly the frozen-loader
    // bug this file exists to prevent.
    for (const cls of animated) {
      if (cls.endsWith(":animate-none")) continue; // suppression, not motion
      const selector = `.${cls.replaceAll(":", String.raw`\:`)}`;
      expect(css, `no CSS emitted for "${cls}"`).toContain(selector);
    }
  });
});
