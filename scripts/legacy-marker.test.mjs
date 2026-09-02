// The legacy-compatibility ledger's enforcement: every class-(A) site (the
// code scheduled for deletion at the next major) carries one grep-able
// marker, and the marker appears NOWHERE else — so the cleanup is one grep
// away and the ledgered set cannot silently grow or rot. The ledger itself
// (with the why per site) lives in packages/api/src/lib/public-origins.ts.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");

// Built at runtime so this file never matches its own scan.
const MARKER = ["LEGACY(", "next-major)"].join("");

const SITES = [
  "packages/api/src/lib/public-origins.ts",
  "apps/gateway/crates/context/src/lib.rs",
  "scripts/install.sh",
  "docker/docker-compose.yml",
  "apps/web/next.config.js",
  // Cloud-only (absent from the OSS mirror; conditional below).
  "packages/infra/lib/api-server-stack.ts",
];

test("every ledgered legacy site carries the marker", () => {
  for (const site of SITES) {
    const path = join(ROOT, site);
    if (!existsSync(path)) continue; // cloud-only rows in the OSS mirror
    assert.ok(
      readFileSync(path, "utf8").includes(MARKER),
      `${site} lost its ${MARKER} marker; update the ledger in public-origins.ts`,
    );
  }
});

test("the marker appears ONLY at ledgered sites", () => {
  // git grep over tracked files: no node_modules, no build output.
  const out = execFileSync(
    "git",
    ["grep", "-l", "--fixed-strings", MARKER, "--", "."],
    { cwd: ROOT, encoding: "utf8" },
  );
  const found = out
    .split("\n")
    .filter(Boolean)
    .filter((f) => f !== "scripts/legacy-marker.test.mjs");
  const unledgered = found.filter((f) => !SITES.includes(f));
  assert.deepEqual(
    unledgered,
    [],
    "new legacy-marked code must join the ledger in public-origins.ts",
  );
});
