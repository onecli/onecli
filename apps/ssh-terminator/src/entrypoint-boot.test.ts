import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * THE SHIPPED BINARY ACTUALLY BOOTS.
 *
 * Every other suite here imports TypeScript through vitest, which resolves
 * CommonJS/ESM interop transparently. Production runs the esbuild ESM bundle
 * under real Node, where that interop is strict — and the gap between the two
 * is a class of bug that passes every test, builds clean, and then
 * crash-loops on deploy. It has happened once for real: the terminator
 * shipped `import { Server } from "ssh2"` (ssh2 is CJS with runtime-attached
 * exports, so Node's lexer cannot see the named export) and every pod died at
 * process start with a SyntaxError while the whole suite stayed green.
 *
 * So: build for real, then start the entrypoint with an EMPTY environment.
 * It must get far enough to refuse on its own config validation — proof the
 * entire module graph loaded — and must never fail with a module-resolution
 * error. Cheap (one esbuild pass, one sub-second boot) against a failure
 * that otherwise reaches the cluster.
 */

const PACKAGE_ROOT = path.resolve(__dirname, "..");

/** Failures that mean the module graph never loaded — the bug class this guards. */
const MODULE_LOAD_FAILURES = [
  "SyntaxError",
  "does not provide an export",
  "Named export",
  "Cannot find module",
  "ERR_MODULE_NOT_FOUND",
  "ERR_REQUIRE_ESM",
];

beforeAll(() => {
  // The real production build.
  execFileSync("node", ["build.mjs"], { cwd: PACKAGE_ROOT, stdio: "pipe" });
}, 120_000);

describe("shipped entrypoint boots under real Node", () => {
  it("dist/index.mjs loads its whole module graph and refuses on config", () => {
    const bundle = path.join(PACKAGE_ROOT, "dist", "index.mjs");
    expect(existsSync(bundle), `${bundle} was not built`).toBe(true);

    // A COMPLETELY empty env on purpose (process.execPath is absolute, so
    // not even PATH is needed): nothing an operator's shell happens to
    // export can satisfy a required variable and mask a boot failure behind
    // a service that then sits waiting on the network.
    const result = spawnSync(process.execPath, [bundle], {
      cwd: PACKAGE_ROOT,
      env: {},
      encoding: "utf8",
      timeout: 30_000,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    for (const failure of MODULE_LOAD_FAILURES) {
      expect(
        output,
        `dist/index.mjs failed to LOAD (${failure}) — a CJS dependency ` +
          "imported by name, or a missing runtime dep. Production would crash-loop.",
      ).not.toContain(failure);
    }
    // The positive control: reaching config validation proves every import
    // in the graph resolved and every module body executed.
    expect(
      output,
      "dist/index.mjs neither refused on config nor reported a load " +
        "error — this guard is only meaningful if the boot path is reached.",
    ).toContain("ConfigError");
  }, 60_000);
});
