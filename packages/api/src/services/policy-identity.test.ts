import { beforeEach, describe, expect, it, vi } from "vitest";

// Focused unit tests for step-6 identity authz + plan-gate: the level restriction
// (workspace → agent/any; org → user/group/any), the org-scoped
// ownership check (the IDOR guard), and the directory-identity plan token. Both
// helpers are DB-light, so we mock @onecli/db with the workspace lookup + the
// per-kind counts (each returns a fixed number the test sets to match/mismatch
// the ids it passes).
const state = vi.hoisted(() => ({
  workspaceOrg: "org-1" as string | null,
  counts: { agent: 0, user: 0, group: 0 },
}));

vi.mock("@onecli/db", () => ({
  Prisma: { JsonNull: "JsonNull" },
  db: {
    workspace: {
      findUnique: async () =>
        state.workspaceOrg ? { organizationId: state.workspaceOrg } : null,
    },
    agent: { count: async () => state.counts.agent },
    organizationMember: { count: async () => state.counts.user },
    group: { count: async () => state.counts.group },
  },
}));

const { assertIdentitiesValid, gatedActions, rowHasDirectoryIdentity } =
  await import("./policy-service");

const orgScope = { scope: "organization" as const, organizationId: "org-1" };
const workspaceScope = { scope: "workspace" as const, workspaceId: "proj-1" };

describe("gatedActions", () => {
  it("emits identity_directory for a directory identity", () => {
    expect(gatedActions({ hasDirectoryIdentity: true })).toEqual([
      "identity_directory",
    ]);
  });

  it("emits nothing for a plain agent / 'any' rule", () => {
    expect(gatedActions({ hasDirectoryIdentity: false })).toEqual([]);
    expect(gatedActions({})).toEqual([]);
  });

  it("combines modifier + directory-identity tokens", () => {
    expect(
      gatedActions({
        requireApproval: true,
        rateLimit: 5,
        hasDirectoryIdentity: true,
      }),
    ).toEqual(["manual_approval", "rate_limit", "identity_directory"]);
  });
});

describe("assertIdentitiesValid — level restriction", () => {
  beforeEach(() => {
    state.workspaceOrg = "org-1";
    // One owned row per kind so the ownership check passes for single-id cases.
    state.counts = { agent: 1, user: 1, group: 1 };
  });

  it("allows 'any' (empty identities) at either level", async () => {
    await expect(assertIdentitiesValid(orgScope, [])).resolves.toBeUndefined();
    await expect(
      assertIdentitiesValid(workspaceScope, []),
    ).resolves.toBeUndefined();
  });

  it("rejects a directory identity on a workspace rule", async () => {
    await expect(
      assertIdentitiesValid(workspaceScope, [{ type: "group", id: "g1" }]),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    await expect(
      assertIdentitiesValid(workspaceScope, [{ type: "user", id: "u1" }]),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("rejects a mixed agent + directory identity on a workspace rule", async () => {
    await expect(
      assertIdentitiesValid(workspaceScope, [
        { type: "agent", id: "a1" },
        { type: "group", id: "g1" },
      ]),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("rejects a specific agent on an org rule", async () => {
    await expect(
      assertIdentitiesValid(orgScope, [{ type: "agent", id: "a1" }]),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("allows an agent on a workspace rule and a group on an org rule", async () => {
    await expect(
      assertIdentitiesValid(workspaceScope, [{ type: "agent", id: "a1" }]),
    ).resolves.toBeUndefined();
    await expect(
      assertIdentitiesValid(orgScope, [{ type: "group", id: "g1" }]),
    ).resolves.toBeUndefined();
  });
});

describe("assertIdentitiesValid — ownership (IDOR guard)", () => {
  beforeEach(() => {
    state.workspaceOrg = "org-1";
    state.counts = { agent: 0, user: 0, group: 0 };
  });

  it("rejects an identity that does not resolve in the acting org", async () => {
    // group count 0 ≠ 1 requested → foreign / missing.
    await expect(
      assertIdentitiesValid(orgScope, [{ type: "group", id: "foreign" }]),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("passes when every referenced id resolves in the org", async () => {
    state.counts.group = 2;
    await expect(
      assertIdentitiesValid(orgScope, [
        { type: "group", id: "g1" },
        { type: "group", id: "g2" },
      ]),
    ).resolves.toBeUndefined();
  });

  it("rejects when only some referenced ids resolve (partial match)", async () => {
    state.counts.group = 1; // own 1, request 2 → mismatch
    await expect(
      assertIdentitiesValid(orgScope, [
        { type: "group", id: "g1" },
        { type: "group", id: "g2" },
      ]),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("fails BAD_REQUEST when the workspace's org can't be resolved", async () => {
    state.workspaceOrg = null;
    await expect(
      assertIdentitiesValid(workspaceScope, [{ type: "agent", id: "a1" }]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// The mechanism `publishPolicy` uses to re-gate a stored draft set on Apply — a
// directory-identity row must still map to the enterprise gate, so a downgraded
// org can't publish a grandfathered directory rule.
describe("rowHasDirectoryIdentity (publish re-gate source)", () => {
  type IdRows = Parameters<typeof rowHasDirectoryIdentity>[0];

  it("is true when a stored rule row carries a directory principal", () => {
    expect(rowHasDirectoryIdentity([{ groupId: "g1" }] as IdRows)).toBe(true);
    expect(rowHasDirectoryIdentity([{ userId: "u1" }] as IdRows)).toBe(true);
  });

  it("is false for an agent-only or empty rule", () => {
    expect(rowHasDirectoryIdentity([{ agentId: "a1" }] as IdRows)).toBe(false);
    expect(rowHasDirectoryIdentity([] as IdRows)).toBe(false);
  });
});
