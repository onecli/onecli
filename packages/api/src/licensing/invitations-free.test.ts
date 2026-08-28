import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LICENSED_ROOTS } from "./ee-boundary";

/**
 * Invitations are FREE, and must stay that way.
 *
 * The licence covers paths, not features: anything under a licensed root is
 * commercially licensed by virtue of living there. Collaboration is not an
 * enterprise feature — a self-hoster invites their team without a licence —
 * so the invitation code has to stay outside those roots, and nothing on the
 * path may demand an entitlement.
 *
 * This is the leaving artifact for the move. Without it, a future refactor
 * could quietly slide invitations back under `ee/` and nothing would object.
 */

// Resolved relative to this file, never via `git rev-parse`: inside a git
// hook (pre-push runs this suite), GIT_DIR points at the invoking checkout's
// git dir and rev-parse answers for the wrong tree.
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

const FREE_INVITATION_FILES = [
  "packages/api/src/services/invitation-service.ts",
  "packages/api/src/services/invitation-email.ts",
  "packages/api/src/routes/invitations.ts",
  "packages/api/src/validations/invitations.ts",
  "packages/api/src/providers/hooks/team-hooks.ts",
];

describe("invitations are free", () => {
  it("lives outside every licensed root", () => {
    for (const file of FREE_INVITATION_FILES) {
      for (const root of LICENSED_ROOTS) {
        expect(file.startsWith(`${root}/`)).toBe(false);
      }
    }
  });

  it("never demands an entitlement", () => {
    // A single `assertEntitled` anywhere on this path would make inviting a
    // teammate a paid action on a self-hosted deployment.
    for (const file of FREE_INVITATION_FILES) {
      const source = readFileSync(`${repoRoot}/${file}`, "utf8");
      expect(source).not.toMatch(/assertEntitled|isEntitled|requireEnterprise/);
    }
  });

  it("reaches the paid parts only through the hook seam", () => {
    // The cloud seat cap and enterprise role mapping are real, and they must
    // arrive by injection — a direct import would drag the licensed billing
    // graph into free code and break the boundary in the other direction.
    const service = readFileSync(
      `${repoRoot}/packages/api/src/services/invitation-service.ts`,
      "utf8",
    );
    expect(service).toContain("getTeamHooks()");
    expect(service).not.toMatch(/quota-service|role-mapping-service|\/ee\//);
  });
});
