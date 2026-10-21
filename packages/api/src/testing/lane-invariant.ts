/**
 * Which `*.pg.test.ts` suites the onprem-default CI lane can skip.
 *
 * CI runs this package twice: once with `NEXT_PUBLIC_EDITION=cloud` and once
 * with the edition env unset (the onprem-default lane), because edition reads
 * freeze at MODULE LOAD (`lib/env.ts`) and the second run is what proves the
 * unset-edition default. A pg suite that writes the edition itself before any
 * module that could read it is loaded runs the same code in both lanes:
 * `hermetic-env.ts` folds `EDITION` and resets every file to the worker
 * baseline, so the suite's own pin is the only edition it ever sees. Running
 * it again in the onprem lane re-proves nothing and costs serial time (the pg
 * project is one fork, one file at a time).
 *
 * A suite is lane-invariant when it pins `EDITION` or `NEXT_PUBLIC_EDITION`
 * to a literal edition, and either
 *  - the pin sits inside a `vi.hoisted` block (it runs before every import),
 *    or
 *  - every value import (not `import type`) is one this module knows to read
 *    no edition at load (`vitest`, `node:*`, and the dependency-free helpers in
 *    `testing/`), and the pin appears in the file before its first dynamic
 *    `import(`, so everything under test arrives after the pin.
 *
 * Anything else stays in both lanes. The rule is deliberately conservative:
 * a suite that statically imports any other module is kept even when that
 * module happens to read the edition only at call time.
 *
 * `vitest.config.ts` uses this to exclude the invariant suites when
 * `ONECLI_API_LANE=onprem`; `lane-invariant.test.ts` pins the rule.
 *
 * Dependency-free on purpose: `vitest.config.ts` imports it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Env var CI's onprem-default step sets (see `.github/workflows/ci.yml`). */
export const API_LANE_ENV = "ONECLI_API_LANE";

const EDITION_PIN =
  /process\.env\.(?:NEXT_PUBLIC_)?EDITION\s*=\s*["'`](?:onprem|cloud)["'`]/;

const HOISTED_BLOCK = /vi\.hoisted\(\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*\)/g;

/** Value imports that read no edition at module load. */
const LOAD_SAFE_IMPORT =
  /^(?:vitest|node:[\w/]+|(?:\.\.?\/)+(?:testing\/)?(?:pg-proof|scoped-prisma)(?:\.js)?)$/;

const VALUE_IMPORT = /^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gms;

export type LaneVerdict =
  | { invariant: true; reason: "hoisted-pin" | "pin-before-dynamic-imports" }
  | {
      invariant: false;
      reason:
        | "no-pin"
        | "static-import-before-pin"
        | "dynamic-import-before-pin";
      imports?: string[];
    };

/** A runtime `import(...)` call; `typeof import("x")` in a type position never runs. */
const DYNAMIC_IMPORT = /(?<!typeof\s+)\bimport\(/;

/** Classify one suite's source (pure, for the guard test). */
export const classifyPgSuite = (source: string): LaneVerdict => {
  const hoistedPin = [...source.matchAll(HOISTED_BLOCK)].some(([block]) =>
    EDITION_PIN.test(block),
  );
  if (hoistedPin) return { invariant: true, reason: "hoisted-pin" };
  const pin = EDITION_PIN.exec(source);
  if (!pin) return { invariant: false, reason: "no-pin" };
  const unsafe = [...source.matchAll(VALUE_IMPORT)]
    .map(([, specifier]) => specifier)
    .filter((specifier): specifier is string => specifier !== undefined)
    .filter((specifier) => !LOAD_SAFE_IMPORT.test(specifier));
  if (unsafe.length > 0) {
    return {
      invariant: false,
      reason: "static-import-before-pin",
      imports: unsafe,
    };
  }
  const firstDynamic = DYNAMIC_IMPORT.exec(source);
  if (firstDynamic && firstDynamic.index < pin.index) {
    return { invariant: false, reason: "dynamic-import-before-pin" };
  }
  return { invariant: true, reason: "pin-before-dynamic-imports" };
};

/** Every `*.pg.test.ts` under `srcDir`, relative to `packageDir`, sorted. */
export const pgSuites = (packageDir: string, srcDir = "src"): string[] =>
  readdirSync(join(packageDir, srcDir), { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".pg.test.ts"))
    .map((path) => relative(packageDir, join(packageDir, srcDir, path)))
    .sort();

/** The pg suites the onprem-default lane skips (paths relative to `packageDir`). */
export const laneInvariantPgSuites = (packageDir: string): string[] =>
  pgSuites(packageDir).filter(
    (path) =>
      classifyPgSuite(readFileSync(join(packageDir, path), "utf8")).invariant,
  );
