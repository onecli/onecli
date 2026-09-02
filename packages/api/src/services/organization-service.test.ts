import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Owner-derived workspace naming. `workspaceNameForOwner` is the single
 * naming law for every auto-provision site; what is pinned here is that its
 * output is ALWAYS a valid workspace name (the ee create path throws on
 * invalid names, so a bad derivation would turn an auto-create flow into a
 * hard failure) and that `bootstrapOrganization` names the workspace after
 * the OWNER, never after the org's display name.
 */

interface OrgCreateArgs {
  data: {
    name: string;
    workspaces: { create: { name: string; slug: string } };
  };
}

const state = vi.hoisted(() => ({
  ownerName: null as string | null,
  orgCreates: [] as OrgCreateArgs[],
}));

// Deliberately NO `workspace.create` and NO `$transaction`: the bootstrap must
// stay a single nested `organization.create` (its atomicity guarantee), so a
// regression back to split writes crashes here instead of passing silently.
vi.mock("@onecli/db", () => ({
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
  db: {
    user: {
      findUnique: async () => ({ name: state.ownerName }),
    },
    organization: {
      create: async (args: OrgCreateArgs) => {
        state.orgCreates.push(args);
        return {
          id: "org-1",
          workspaces: [{ id: "ws-1", organizationId: "org-1" }],
        };
      },
    },
  },
}));

vi.mock("../providers", () => ({
  getNewOrgPolicySeeder: () => ({ seed: async () => {} }),
}));

import {
  bootstrapOrganization,
  workspaceNameForOwner,
} from "./organization-service";

beforeEach(() => {
  state.ownerName = null;
  state.orgCreates.length = 0;
});

describe("workspaceNameForOwner", () => {
  it("uses the owner's display name, trimmed", () => {
    expect(workspaceNameForOwner("  John Smith  ", "j@x.com")).toBe(
      "John Smith",
    );
  });

  it("falls back to the email when the name is null or undefined", () => {
    expect(workspaceNameForOwner(null, "owner@example.com")).toBe(
      "owner@example.com",
    );
    expect(workspaceNameForOwner(undefined, "owner@example.com")).toBe(
      "owner@example.com",
    );
  });

  it("rejects a whitespace-only name (validateDisplayName treats empty as valid)", () => {
    expect(workspaceNameForOwner("   ", "owner@example.com")).toBe(
      "owner@example.com",
    );
  });

  it("rejects a name below the 2-char minimum", () => {
    expect(workspaceNameForOwner("J", "owner@example.com")).toBe(
      "owner@example.com",
    );
  });

  it("rejects a name above the 50-char maximum", () => {
    expect(workspaceNameForOwner("x".repeat(51), "owner@example.com")).toBe(
      "owner@example.com",
    );
  });

  it("rejects a name without an ASCII letter or digit (platform rule)", () => {
    expect(workspaceNameForOwner("田中太郎", "tanaka@example.jp")).toBe(
      "tanaka@example.jp",
    );
  });

  it("converges when the name IS the email (cloud Cognito claim fallback)", () => {
    expect(
      workspaceNameForOwner("owner@example.com", "owner@example.com"),
    ).toBe("owner@example.com");
  });

  it("clamps an over-long email to the 50-char maximum", () => {
    const longEmail = `${"a".repeat(60)}@example.com`;
    expect(workspaceNameForOwner(null, longEmail)).toBe("a".repeat(50));
  });

  it("survives a pathological email with the final guard", () => {
    expect(workspaceNameForOwner(null, "   ")).toBe("Personal");
    expect(workspaceNameForOwner(null, "@-.")).toBe("Personal");
  });

  it("never splits a surrogate pair at the clamp boundary", () => {
    // 49 ASCII chars put the emoji (2 UTF-16 units) astride index 50; the
    // clamp must drop the orphaned high half, not emit an ill-formed string.
    const email = `${"a".repeat(49)}\u{1F600}@example.com`;
    expect(workspaceNameForOwner(null, email)).toBe("a".repeat(49));
  });
});

describe("bootstrapOrganization workspace naming", () => {
  it("names the first workspace after the owner, slug derived", async () => {
    state.ownerName = "John Smith";
    await bootstrapOrganization("user-1", "john@x.com");
    expect(state.orgCreates[0]?.data.workspaces.create).toMatchObject({
      name: "John Smith",
      slug: "john-smith",
    });
  });

  it("never names the workspace after the org's display name", async () => {
    state.ownerName = "John Smith";
    await bootstrapOrganization("user-1", "john@x.com", "Acme Inc");
    // The org takes the typed display name; the workspace takes the owner's.
    expect(state.orgCreates[0]?.data.name).toBe("Acme Inc");
    expect(state.orgCreates[0]?.data.workspaces.create.name).toBe("John Smith");
  });

  it("falls back to the owner's email when they have no display name", async () => {
    state.ownerName = null;
    await bootstrapOrganization("user-1", "john@x.com");
    expect(state.orgCreates[0]?.data.workspaces.create).toMatchObject({
      name: "john@x.com",
      slug: "john-x-com",
    });
  });
});
