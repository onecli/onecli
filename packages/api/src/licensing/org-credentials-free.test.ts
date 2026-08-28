import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LICENSED_ROOTS } from "./ee-boundary";

/**
 * Org-level credentials are FREE, and must stay that way.
 *
 * One org-level connection, secret, or LLM key serves every workspace in the
 * organization — sharing credentials across workspaces is how a self-hosted
 * team runs the product, not an enterprise feature. The whole surface
 * (connections, secrets, custom OAuth config, blocklist, and the org OAuth
 * handlers behind it) left `ee/` in the org-credentials carve, and nothing on
 * the path may demand an entitlement.
 *
 * This is the leaving artifact for the move (the invitations precedent).
 * Without it, a future refactor could quietly slide org credentials back
 * under `ee/` and nothing would object.
 */

// Resolved relative to this file, never via `git rev-parse`: inside a git
// hook (pre-push runs this suite), GIT_DIR points at the invoking checkout's
// git dir and rev-parse answers for the wrong tree.
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

const FREE_ORG_CREDENTIAL_FILES = [
  // API surface
  "packages/api/src/routes/org-connections.ts",
  "packages/api/src/routes/org-apps.ts",
  "packages/api/src/routes/org-secrets.ts",
  // Org OAuth + credential-resolution cores (also the shared interceptor
  // implementations boot-injected into the oauthOrg/orgAppConfig slots)
  "packages/api/src/apps/oauth-org.ts",
  "packages/api/src/apps/resolve-org-credentials.ts",
  "packages/api/src/apps/org-app-config.ts",
  // Web surface (layout.tsx carried the old EnterpriseLockedCard gate)
  "apps/web/src/app/(dashboard)/org/[orgId]/(admin)/global-connections/layout.tsx",
  "apps/web/src/app/(dashboard)/org/[orgId]/(admin)/global-connections/_components/global-connections-layout.tsx",
  "apps/web/src/app/(dashboard)/org/[orgId]/(admin)/global-connections/_components/global-connections-tabs.tsx",
  "apps/web/src/app/(dashboard)/org/[orgId]/(admin)/global-connections/_components/global-apps-page.tsx",
  "apps/web/src/app/(dashboard)/org/[orgId]/(admin)/global-connections/_components/global-connected-page.tsx",
  "apps/web/src/app/(dashboard)/org/[orgId]/(admin)/global-connections/_components/global-secrets-page.tsx",
  "apps/web/src/app/(dashboard)/org/[orgId]/(admin)/global-connections/_components/global-app-detail-page.tsx",
  "apps/web/src/lib/actions/org-secrets.ts",
  "apps/web/src/lib/actions/org-app-config.ts",
];

describe("org credentials are free", () => {
  it("lives outside every licensed root", () => {
    for (const file of FREE_ORG_CREDENTIAL_FILES) {
      for (const root of LICENSED_ROOTS) {
        expect(file.startsWith(`${root}/`)).toBe(false);
      }
    }
  });

  it("never demands an entitlement", () => {
    // A single entitlement demand anywhere on this path would make sharing a
    // credential across workspaces a paid action on a self-hosted deployment.
    for (const file of FREE_ORG_CREDENTIAL_FILES) {
      const source = readFileSync(`${repoRoot}/${file}`, "utf8");
      expect(source).not.toMatch(/assertEntitled|isEntitled|requireEnterprise/);
    }
  });

  it("reaches the paid parts only through the hook seams", () => {
    // The cloud plan quota on secret creation is real, and it must arrive by
    // injection — a direct quota-service import would drag the licensed
    // billing graph into free code and break the boundary the other way.
    const secrets = readFileSync(
      `${repoRoot}/packages/api/src/routes/org-secrets.ts`,
      "utf8",
    );
    expect(secrets).toContain("getResourceHooks()");
    expect(secrets).not.toMatch(/quota-service|\/ee\//);

    // The connect/OAuth cores must not statically reach anything left in ee/.
    for (const file of [
      "packages/api/src/routes/org-apps.ts",
      "packages/api/src/routes/org-connections.ts",
      "packages/api/src/apps/oauth-org.ts",
    ]) {
      const source = readFileSync(`${repoRoot}/${file}`, "utf8");
      expect(source).not.toMatch(/\/ee\/|\.\.\/ee\//);
    }
  });
});
