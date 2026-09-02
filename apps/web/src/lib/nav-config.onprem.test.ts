import { describe, expect, it, vi } from "vitest";

/**
 * The Groups nav-visibility truth table on the SELF-HOST lane.
 *
 * Its own file because the rule is lane-specific: `nav-config` reads `CAPS`,
 * which `@/lib/env` freezes at module load, so the shared nav-config.test.ts
 * (running under whatever edition the CI lane sets) cannot host it. On an
 * RBAC build the entry always shows — that arm is nav-config.cloud.test.ts.
 *
 * The rule itself: hidden while the runtime entitlement is UNKNOWN (no flash
 * before `GET /v1/instance` answers), shown once it is known EITHER way — an
 * unlicensed deployment still shows the entry, which lands on the
 * server-gated license card rather than pretending the feature is absent.
 */

// Deleted before the module graph loads: NEXT_PUBLIC_EDITION freezes CAPS,
// and EDITION would silently re-decide the edition underneath it.
vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_EDITION;
  delete process.env.EDITION;
  delete process.env.ENTERPRISE_ENABLED;
});

const { getNavItems } = await import("./nav-config");
const { CAPS } = await import("./env");

const titles = (opts?: Parameters<typeof getNavItems>[1]) =>
  getNavItems("org-1", opts)
    .flat()
    .map((item) => item.title);

describe("Groups nav visibility (self-host)", () => {
  it("premise: this lane is a non-RBAC build, so entitlement alone decides", () => {
    // Without this the assertions below would pass for the wrong reason on a
    // cloud-pinned run (CAPS.rbac true shows Groups unconditionally).
    expect(CAPS.rbac).toBe(false);
  });

  it("hides Groups while the entitlement answer is unknown", () => {
    expect(titles()).not.toContain("Groups");
    expect(titles({ entitled: undefined })).not.toContain("Groups");
    expect(titles({ entitled: null })).not.toContain("Groups");
  });

  it("shows Groups once entitlement is KNOWN — false included", () => {
    expect(titles({ entitled: false })).toContain("Groups");
    expect(titles({ entitled: true })).toContain("Groups");
  });
});
