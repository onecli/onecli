import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isToleratedPruneError, pruneManagedRoot } from "./fs";

/**
 * The prune walk against a real tmpdir — specifically the inaccessible-entry
 * law: with rootless containers in the sandbox, a nested-container volume
 * mount can leave subuid-owned mode-700 directories under a managed root that
 * this process can neither read nor delete. The walk must skip them (counted,
 * warned by the caller) instead of throwing — a throwing walk poisons every
 * subsequent sync generation of the whole root over one stray entry.
 *
 * Simulated with chmod 000 (an unreadable dir behaves like a foreign-uid
 * dir); meaningless as root, where DAC checks pass regardless — skipped there.
 */

const asRoot = process.getuid?.() === 0;

let home: string;
let locked: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "onecli-fs-test-"));
  mkdirSync(join(home, "skills"));
  writeFileSync(join(home, "skills", "keep.md"), "keep");
  writeFileSync(join(home, "skills", "stray.md"), "stray");
  locked = join(home, "skills", "foreign");
  mkdirSync(locked);
  writeFileSync(join(locked, "layer"), "opaque");
});

afterEach(() => {
  // Re-open the locked dir so the tmpdir can be cleaned up.
  try {
    chmodSync(locked, 0o755);
  } catch {
    // already pruned
  }
});

describe("pruneManagedRoot", () => {
  it("returns 0 when every entry is accessible", () => {
    const inaccessible = pruneManagedRoot(
      home,
      "skills",
      new Set(["skills/keep.md"]),
    );
    expect(inaccessible).toBe(0);
    expect(existsSync(join(home, "skills", "keep.md"))).toBe(true);
    expect(existsSync(join(home, "skills", "stray.md"))).toBe(false);
    // Accessible non-manifest dirs fold up entirely.
    expect(existsSync(locked)).toBe(false);
  });

  it.skipIf(asRoot)(
    "skips an unreadable directory, counts it EXACTLY once, and still prunes the rest",
    () => {
      chmodSync(locked, 0o000);
      const inaccessible = pruneManagedRoot(
        home,
        "skills",
        new Set(["skills/keep.md"]),
      );
      // Exactly one — the readdir throw is counted, and the parent skips the
      // empty-fold for a child it couldn't read (regression guard: the naive
      // version re-counted the same dir at the fold, reporting 2).
      expect(inaccessible).toBe(1);
      expect(existsSync(locked)).toBe(true);
      // The rest of the prune still happened.
      expect(existsSync(join(home, "skills", "keep.md"))).toBe(true);
      expect(existsSync(join(home, "skills", "stray.md"))).toBe(false);
    },
  );

  it("rethrows a non-permission fault instead of swallowing it as inaccessible", () => {
    // Only EPERM/EACCES/ENOENT/ENOTEMPTY are tolerated; a real IO fault must
    // propagate so a sync generation is never falsely acked as pruned.
    const io = Object.assign(new Error("simulated disk fault"), {
      code: "EIO",
    });
    expect(isToleratedPruneError(io)).toBe(false);
    for (const code of ["EPERM", "EACCES", "ENOENT", "ENOTEMPTY"]) {
      expect(
        isToleratedPruneError(Object.assign(new Error("x"), { code })),
      ).toBe(true);
    }
    expect(isToleratedPruneError(new Error("no code"))).toBe(false);
  });
});
