import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The OSS sync is deny-list shaped: every file syncs unless CLOUD-DEVELOPMENT.md's
// exclusion table names it, and that table is prose with no other gate
// (plans/sandbox-platform.md §3.11). This guard makes the boundary mechanical
// for whole cloud-only PACKAGES: each one listed below must have an exclusion
// row, so deleting the row (or adding a cloud-only package without one) fails
// `pnpm check` on the cloud side before a sync window can ever carry the
// package upstream.

/** Workspace packages that must never reach the OSS mirror. */
const CLOUD_ONLY_PACKAGES = ["packages/infra", "apps/sandbox-manager"];

const path = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

// `scripts/` itself syncs to OSS, where the boundary doc and the cloud-only
// directories are absent by design — there this file must be a silent no-op
// (the scripts/dev.mjs existsSync precedent). Repo identity is keyed on the
// root package name, which the sync rewrites field-level — NOT on the
// boundary doc's existence, or renaming the doc would silently disarm the
// guard in the very repo it protects.
const boundaryDoc = path("CLOUD-DEVELOPMENT.md");
const rootPackageName = JSON.parse(
  readFileSync(path("package.json"), "utf8"),
).name;
const inCloudRepo = rootPackageName === "onecli-cloud";

test("cloud-only packages each have an exclusion row", { skip: !inCloudRepo }, () => {
  assert.ok(
    existsSync(boundaryDoc),
    "CLOUD-DEVELOPMENT.md is missing from the cloud repo — the exclusion list (and this guard's subject) is gone",
  );
  const doc = readFileSync(boundaryDoc, "utf8");
  // Exclusion rows are table lines whose first cell is a backticked pattern.
  const patternCells = [...doc.matchAll(/^\|\s*`([^`]+)`/gm)].map((m) => m[1]);

  // Positive controls: a reformatted table must fail here, not pass vacuously.
  assert.ok(
    patternCells.length >= 8,
    `expected the exclusion table's pattern cells, found ${patternCells.length}`,
  );
  assert.ok(
    !patternCells.some((cell) => cell.startsWith("apps/web/**")),
    "apps/web is shared — a row excluding it means the parse grabbed the wrong table",
  );

  for (const pkg of CLOUD_ONLY_PACKAGES) {
    assert.ok(
      existsSync(path(pkg)),
      `${pkg} is in CLOUD_ONLY_PACKAGES but does not exist — remove it here`,
    );
    assert.ok(
      patternCells.some((cell) => cell === `${pkg}/**`),
      `${pkg} exists but CLOUD-DEVELOPMENT.md's exclusion table has no \`${pkg}/**\` row — ` +
        "without it, /sync-oss would copy the whole package to the public mirror.",
    );
  }
});
