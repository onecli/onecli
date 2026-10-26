import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyPgSuite,
  laneInvariantPgSuites,
  pgSuites,
} from "./lane-invariant";

/**
 * The onprem-default CI lane skips the pg suites this rule calls
 * lane-invariant (see lane-invariant.ts). A wrong "invariant" verdict would
 * silently drop a suite's only unset-edition run, so the rule is pinned in
 * both directions, and the real suites are re-checked here on every run.
 */

const PACKAGE_DIR = join(import.meta.dirname, "..", "..");

const pinInBeforeAll = `
import { beforeAll } from "vitest";
import { proofDatabaseUrl } from "../testing/pg-proof.js";
beforeAll(async () => {
  process.env.EDITION = "onprem";
  ({ db } = await import("@onecli/db"));
});`;

describe("classifyPgSuite", () => {
  it("a pin inside vi.hoisted is invariant, whatever is imported after it", () => {
    const source = `
import { vi } from "vitest";
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});
import { createApiApp } from "../app";`;
    expect(classifyPgSuite(source)).toEqual({
      invariant: true,
      reason: "hoisted-pin",
    });
  });

  it("a beforeAll pin with only load-safe imports is invariant", () => {
    expect(classifyPgSuite(pinInBeforeAll)).toEqual({
      invariant: true,
      reason: "pin-before-dynamic-imports",
    });
  });

  it("a type-only import never counts against the pin", () => {
    const source = `import type { db } from "@onecli/db";\n${pinInBeforeAll}`;
    expect(classifyPgSuite(source).invariant).toBe(true);
  });

  it("a static import of anything else keeps the suite in both lanes", () => {
    const source = `import { isEntitled } from "../lib/entitlements";\n${pinInBeforeAll}`;
    expect(classifyPgSuite(source)).toEqual({
      invariant: false,
      reason: "static-import-before-pin",
      imports: ["../lib/entitlements"],
    });
  });

  it("a dynamic import that runs before the pin keeps the suite in both lanes", () => {
    const source = `
import { beforeAll } from "vitest";
const early = await import("../lib/env");
beforeAll(() => {
  process.env.EDITION = "onprem";
});`;
    expect(classifyPgSuite(source)).toEqual({
      invariant: false,
      reason: "dynamic-import-before-pin",
    });
  });

  it("a suite that never pins an edition keeps running in both lanes", () => {
    const source = `import { proofDatabaseUrl } from "../testing/pg-proof.js";`;
    expect(classifyPgSuite(source)).toEqual({
      invariant: false,
      reason: "no-pin",
    });
  });

  it("deleting the edition (not pinning it) is not a pin", () => {
    const source = `
import { beforeAll } from "vitest";
beforeAll(() => {
  delete process.env.EDITION;
});`;
    expect(classifyPgSuite(source).invariant).toBe(false);
  });
});

describe("the real pg suites", () => {
  const all = pgSuites(PACKAGE_DIR);
  const invariant = laneInvariantPgSuites(PACKAGE_DIR);

  it("finds the suites at all (the scan is not silently empty)", () => {
    expect(all.length).toBeGreaterThan(50);
  });

  it("keeps the unpinned and import-first suites in the onprem lane", () => {
    // A guard against the rule drifting to "skip everything".
    expect(invariant.length).toBeLessThan(all.length);
    expect(all.length - invariant.length).toBeGreaterThan(10);
  });

  it("every skipped suite really writes an edition before importing code under test", () => {
    for (const path of invariant) {
      const source = readFileSync(join(PACKAGE_DIR, path), "utf8");
      expect(source, path).toMatch(
        /process\.env\.(?:NEXT_PUBLIC_)?EDITION\s*=\s*["'`](?:onprem|cloud)["'`]/,
      );
    }
  });
});
