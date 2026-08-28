import { beforeEach, describe, expect, it, vi } from "vitest";

// The shared predicates branch on CAPS.rbac (flat team vs enforced roles) and
// then delegate to the injected WorkspaceAccessChecker. CAPS is module-load
// resolved, so the edition is mocked with a mutable handle — the same pattern
// as middleware/auth.test.ts. IS_CLOUD is pinned false: the missing-checker
// arm under test is the ENTITLED SELF-HOST posture (rbac on, slot empty →
// loud deny); on cloud the slot getter throws `failMissingCloudDefault`
// instead, so without the pin the suite is edition-sensitive and goes red on
// the CI lane that sets NEXT_PUBLIC_EDITION=cloud job-wide.
const caps = vi.hoisted(() => ({ rbac: false }));
vi.mock("../lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/env")>();
  return {
    ...actual,
    IS_CLOUD: false,
    CAPS: {
      ...actual.CAPS,
      get rbac() {
        return caps.rbac;
      },
    },
  };
});

import { initWorkspaceAccessChecker } from "../providers/access-checker";
import { logger } from "../lib/logger";
import {
  canAccessWorkspaceAsUser,
  userIsOrgAdmin,
} from "./workspace-access-check";

const WS = { id: "ws-1", organizationId: "org-1" };

describe("workspace-access-check (the provider seam)", () => {
  beforeEach(() => {
    caps.rbac = false;
    initWorkspaceAccessChecker(null);
  });

  it("flat team (no RBAC): always allowed, the slot is never consulted", async () => {
    const checker = {
      canAccessWorkspaceAsUser: vi.fn(async () => false),
      userIsOrgAdmin: vi.fn(async () => false),
    };
    initWorkspaceAccessChecker(checker);
    await expect(canAccessWorkspaceAsUser("u-1", WS)).resolves.toBe(true);
    await expect(userIsOrgAdmin("u-1", "org-1")).resolves.toBe(true);
    // Even a deny-everything checker is ignored on the flat team.
    expect(checker.canAccessWorkspaceAsUser).not.toHaveBeenCalled();
    expect(checker.userIsOrgAdmin).not.toHaveBeenCalled();
  });

  it("RBAC with no checker fails closed AND loud (host wiring bug, not flat team)", async () => {
    caps.rbac = true;
    // The loudness IS part of the guard: silent denial once bounced every
    // entitled self-host owner off their own workspace with nothing in any
    // log. Pin both the deny and the error line.
    const errorSpy = vi.spyOn(logger, "error");
    await expect(canAccessWorkspaceAsUser("u-1", WS)).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      { userId: "u-1", workspaceId: "ws-1" },
      expect.stringContaining("no access checker"),
    );
    await expect(userIsOrgAdmin("u-1", "org-1")).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      { userId: "u-1", organizationId: "org-1" },
      expect.stringContaining("no access checker"),
    );
    errorSpy.mockRestore();
  });

  it("RBAC: delegates to the injected checker with the exact arguments", async () => {
    caps.rbac = true;
    const checker = {
      canAccessWorkspaceAsUser: vi.fn(async () => true),
      userIsOrgAdmin: vi.fn(async () => false),
    };
    initWorkspaceAccessChecker(checker);

    await expect(canAccessWorkspaceAsUser("u-1", WS)).resolves.toBe(true);
    expect(checker.canAccessWorkspaceAsUser).toHaveBeenCalledWith("u-1", WS);

    await expect(userIsOrgAdmin("u-2", "org-9")).resolves.toBe(false);
    expect(checker.userIsOrgAdmin).toHaveBeenCalledWith("u-2", "org-9");
  });

  it("RBAC: the checker's verdict is returned unmodified", async () => {
    caps.rbac = true;
    initWorkspaceAccessChecker({
      canAccessWorkspaceAsUser: async () => false,
      userIsOrgAdmin: async () => true,
    });
    await expect(canAccessWorkspaceAsUser("u-1", WS)).resolves.toBe(false);
    await expect(userIsOrgAdmin("u-1", "org-1")).resolves.toBe(true);
  });
});
