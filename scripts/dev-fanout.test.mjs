import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  HOST_DEV_PACKAGES,
  NEVER_HOST_DEV_PACKAGES,
  devExcludeFilters,
} from "./lib/dev-services.mjs";

// `pnpm dev` hands off to `turbo run dev`, which runs the `dev` task of EVERY
// package that defines one — so adding or renaming a script silently changes
// what the dev command starts. That is how the sandbox supervisor (a
// container-only process) joined the host fan-out, failed on `mkdir
// /workspace`, and aborted every other persistent task with it.
//
// CI never launches `pnpm dev`, so nothing else can catch this class. These
// assertions are the guard: the fan-out must be exactly the declared set, and
// the container-only packages must be excluded by name.

// Resolved from this file's location — never `git rev-parse`, which the
// pre-push hook's GIT_DIR poisons inside worktrees.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const workspacePackages = () => {
  const names = [];
  for (const dir of ["apps", "packages"]) {
    const base = join(repoRoot, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const manifest = join(base, entry, "package.json");
      if (!existsSync(manifest)) continue;
      names.push(JSON.parse(readFileSync(manifest, "utf8")));
    }
  }
  return names;
};

test("the dev fan-out is exactly the declared host services", () => {
  const withDev = workspacePackages()
    .filter((p) => p.scripts?.dev)
    .map((p) => p.name)
    .sort();

  // Anti-vacuous: an empty scan would "pass" while proving nothing.
  assert.ok(withDev.length > 3, `found only ${withDev.length} dev scripts`);

  assert.deepEqual(
    withDev,
    [...HOST_DEV_PACKAGES].sort(),
    "a package gained or lost a `dev` script: `pnpm dev` now starts a " +
      "different set. Add it to HOST_DEV_PACKAGES if it really is a host " +
      "service, or give the script another name (see " +
      "scripts/lib/dev-services.mjs).",
  );
});

test("container-only packages define no dev script at all", () => {
  const byName = new Map(workspacePackages().map((p) => [p.name, p]));
  for (const name of NEVER_HOST_DEV_PACKAGES) {
    const pkg = byName.get(name);
    // A stale entry would silently protect nothing.
    assert.ok(pkg, `${name} is declared container-only but does not exist`);
    assert.ok(
      !pkg.scripts?.dev,
      `${name} runs inside a container — its host entry point must not be ` +
        "called `dev` (the launcher filters it too, but the name is the trap)",
    );
  }
});

test("the launcher excludes every container-only package", () => {
  const filters = devExcludeFilters();
  for (const name of NEVER_HOST_DEV_PACKAGES) {
    assert.ok(
      filters.includes(`--filter=!${name}`),
      `devExcludeFilters() does not exclude ${name}`,
    );
  }
  // The constant is worthless unless the launcher actually spreads it.
  const launcher = readFileSync(join(repoRoot, "scripts/dev.mjs"), "utf8");
  assert.match(
    launcher,
    /\.\.\.devExcludeFilters\(\)/,
    "scripts/dev.mjs no longer applies devExcludeFilters() to its turbo args",
  );
});
