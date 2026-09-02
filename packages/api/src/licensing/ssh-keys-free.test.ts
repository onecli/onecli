import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LICENSED_ROOTS } from "./ee-boundary";

/**
 * Registered SSH keys are FREE, and must stay that way.
 *
 * The licence covers paths, not features: anything under a licensed root is
 * commercially licensed by virtue of living there. SSHing into your own
 * agent's machine is core product, not an enterprise feature — a self-hoster
 * who configures the SSH front door registers keys without a licence — so
 * the registry code has to stay outside those roots, and nothing on the
 * path may demand an entitlement.
 *
 * This is the leaving artifact for the feature. Without it, a future
 * refactor could quietly slide key management under `ee/` and nothing
 * would object.
 */

// Resolved relative to this file, never via `git rev-parse`: inside a git
// hook (pre-push runs this suite), GIT_DIR points at the invoking checkout's
// git dir and rev-parse answers for the wrong tree.
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

const FREE_SSH_KEY_FILES = [
  "packages/api/src/services/ssh-key-service.ts",
  "packages/api/src/services/ssh-service.ts",
  "packages/api/src/routes/user.ts",
  "packages/api/src/validations/ssh-keys.ts",
  "packages/ssh-cert/src/keys.ts",
];

describe("registered ssh keys are free", () => {
  it("lives outside every licensed root", () => {
    for (const file of FREE_SSH_KEY_FILES) {
      for (const root of LICENSED_ROOTS) {
        expect(file.startsWith(`${root}/`)).toBe(false);
      }
    }
  });

  it("never demands an entitlement", () => {
    // A single `assertEntitled` anywhere on this path would make SSH access
    // to your own agent a paid action on a self-hosted deployment.
    for (const file of FREE_SSH_KEY_FILES) {
      const source = readFileSync(`${repoRoot}/${file}`, "utf8");
      expect(source).not.toMatch(/assertEntitled|isEntitled|requireEnterprise/);
    }
  });

  it("never imports licensed code", () => {
    // The registry has no paid dependency at all — not even a hook seam. A
    // static `ee/` import appearing here would drag licensed code into the
    // free product's SSH path.
    for (const file of FREE_SSH_KEY_FILES) {
      const source = readFileSync(`${repoRoot}/${file}`, "utf8");
      expect(source).not.toMatch(/\/ee\/|\.\.\/ee\b|@\/ee\//);
    }
  });
});
