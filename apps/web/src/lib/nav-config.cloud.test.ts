import { describe, expect, it, vi } from "vitest";

/**
 * Cloud arm of the Groups nav-visibility rule: on an RBAC build the entry is
 * present regardless of the runtime entitlement answer — cloud is always
 * entitled, so there is nothing to wait for and no flash to avoid. This is
 * the arm the self-host twin (nav-config.onprem.test.ts) must NOT be read as
 * contradicting; only the pin differs.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  delete process.env.EDITION;
  delete process.env.ENTERPRISE_ENABLED;
});

const { getNavItems } = await import("./nav-config");
const { CAPS } = await import("./env");

const titles = (opts?: Parameters<typeof getNavItems>[1]) =>
  getNavItems("org-1", opts)
    .flat()
    .map((item) => item.title);

describe("Groups nav visibility (cloud)", () => {
  it("premise: this lane is an RBAC build", () => {
    expect(CAPS.rbac).toBe(true);
  });

  it("shows Groups for every entitlement answer, unknown included", () => {
    for (const opts of [
      undefined,
      { entitled: undefined },
      { entitled: null },
      { entitled: false },
      { entitled: true },
    ] as const) {
      expect(titles(opts), JSON.stringify(opts)).toContain("Groups");
    }
  });
});

// Billing & usage is one Settings modal page; the sidebar keys rows by URL,
// so a Usage row beside Billing would open the same page under two names.
describe("Billing nav (cloud)", () => {
  it("premise: this lane bills", () => {
    expect(CAPS.billing).toBe(true);
  });

  it("offers one Billing row and no Usage row", () => {
    const shown = titles();
    expect(shown.filter((t) => t === "Billing")).toHaveLength(1);
    expect(shown).not.toContain("Usage");
  });
});
