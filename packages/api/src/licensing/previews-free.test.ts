import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LICENSED_ROOTS } from "./ee-boundary";

/**
 * Sandbox previews (shared ports) are FREE, and must stay that way.
 *
 * The licence covers paths, not features: anything under a licensed root is
 * commercially licensed by virtue of living there. Showing a web app your
 * own agent runs to a person is core product, the sibling of SSH in the
 * agent's Advanced menu (both are ways into the agent's computer), and the
 * ENTERPRISE_FEATURES list is org-scale controls (SSO, SCIM, RBAC, budgets,
 * HA), not agent capabilities. A self-hoster who stands up the preview
 * front door (wildcard DNS + a proxy + the relay) shares ports without a
 * licence, so the whole path, from the agent's tool to the viewer's
 * cookie, has to stay outside those roots and must never demand an
 * entitlement. Where the deployment has no front door the feature is dark
 * by configuration (`previewAvailability`), never by licence.
 *
 * This is the leaving artifact for the feature. Without it, a future
 * refactor could quietly slide previews under `ee/` and nothing would
 * object.
 */

// Resolved relative to this file, never via `git rev-parse`: inside a git
// hook (pre-push runs this suite), GIT_DIR points at the invoking checkout's
// git dir and rev-parse answers for the wrong tree.
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

const FREE_PREVIEW_FILES = [
  // Control plane: the share rows, the agent's tool, the relay's channel,
  // the login handoff, and the "is it configured" answer.
  "packages/api/src/routes/sandbox-ports.ts",
  "packages/api/src/services/sandbox-port-service.ts",
  "packages/api/src/services/preview-expose-service.ts",
  "packages/api/src/lib/preview-availability.ts",
  // Dashboard: the Ports page and the signed-out handoff page.
  "apps/web/src/app/(dashboard)/w/[workspaceId]/agents/[agentId]/ports/page.tsx",
  "apps/web/src/app/(dashboard)/w/[workspaceId]/agents/[agentId]/ports/_components/ports-section.tsx",
  "apps/web/src/app/preview-auth/page.tsx",
  "apps/web/src/hooks/use-ports.ts",
  "apps/web/src/lib/api/ports.ts",
  // Data plane: discovery and streams in the sandbox, the hub in the runner.
  "apps/sandbox-supervisor/src/capabilities/previews.ts",
  "apps/sandbox-supervisor/src/capabilities/port-discovery.ts",
  "apps/sandbox-supervisor/src/capabilities/port-streams.ts",
  "apps/runner/src/port-hub.ts",
  "apps/runner/src/port-api.ts",
];

describe("sandbox previews are free", () => {
  it("lives outside every licensed root", () => {
    for (const file of FREE_PREVIEW_FILES) {
      for (const root of LICENSED_ROOTS) {
        expect(file.startsWith(`${root}/`)).toBe(false);
      }
    }
  });

  it("never demands an entitlement", () => {
    // A single `assertEntitled` anywhere on this path would make showing
    // your own agent's app a paid action on a self-hosted deployment.
    for (const file of FREE_PREVIEW_FILES) {
      const source = readFileSync(`${repoRoot}/${file}`, "utf8");
      expect(source).not.toMatch(/assertEntitled|isEntitled|requireEnterprise/);
    }
  });

  it("never imports licensed code", () => {
    // No paid dependency at all, not even a hook seam. A static `ee/`
    // import appearing here would drag licensed code into the free
    // product's preview path.
    for (const file of FREE_PREVIEW_FILES) {
      const source = readFileSync(`${repoRoot}/${file}`, "utf8");
      expect(source).not.toMatch(/\/ee\/|\.\.\/ee\b|@\/ee\//);
    }
  });

  it("is dark by configuration, not by licence", () => {
    // The one gate on the feature is "does this deployment have a preview
    // front door": the api answers from PREVIEW_* env, never from the
    // entitlement. Pins the reason the menu hides on an unconfigured
    // self-host, so it is never mistaken for a licence wall.
    const source = readFileSync(
      `${repoRoot}/packages/api/src/lib/preview-availability.ts`,
      "utf8",
    );
    expect(source).toMatch(/PREVIEW_DOMAIN/);
    expect(source).toMatch(/PREVIEW_RELAY_SECRET/);
    expect(source).not.toMatch(/ENTERPRISE_ENABLED|entitled/i);
  });
});
