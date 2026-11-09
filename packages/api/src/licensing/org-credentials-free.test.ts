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
  // Connection-native repository grants are free, unlike per-agent policies.
  "packages/api/src/routes/github-app-share.ts",
  "packages/api/src/services/github-app-share-service.ts",
  "apps/web/src/hooks/use-github-app-share.ts",
  "apps/web/src/app/(dashboard)/w/[workspaceId]/connections/_components/edit-repositories-dialog.tsx",
  "apps/web/src/app/(dashboard)/w/[workspaceId]/connections/_components/repo-scope-picker.tsx",
  // Org OAuth + credential-resolution cores (also the shared interceptor
  // implementations boot-injected into the oauthOrg/orgAppConfig slots)
  "packages/api/src/apps/oauth-org.ts",
  "packages/api/src/apps/resolve-org-credentials.ts",
  "packages/api/src/apps/org-app-config.ts",
  // Web surface: Settings > Organization > Shared apps (the modal body that
  // replaced the global-connections route pages; the old layout.tsx carried
  // the EnterpriseLockedCard gate). The only lock left on the page is the
  // App Availability editor, an enterprise control, not the credentials.
  "apps/web/src/lib/settings-modal/shared-apps-body.tsx",
  "apps/web/src/lib/settings-modal/workspace-app-detail-body.tsx",
  "apps/web/src/lib/settings-modal/shared-app-detail-body.tsx",
  "apps/web/src/app/(dashboard)/org/[orgId]/(admin)/settings/global-connections/_components/global-app-detail-page.tsx",
  "apps/web/src/lib/actions/org-secrets.ts",
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
