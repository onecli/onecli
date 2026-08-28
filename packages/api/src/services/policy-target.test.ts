import { beforeEach, describe, expect, it, vi } from "vitest";

// Focused unit tests for step-8 TARGET authz: the connection/secret reference
// ownership check (the IDOR guard) that mirrors `assertIdentitiesValid`. Every
// referenced connection/secret must belong to the acting org — a workspace rule to
// its workspace + org-level resources, an org rule to org-level resources. The
// helper is DB-light, so we mock @onecli/db with the workspace lookup + the two
// counts, capturing each `where` so the org/workspace fence itself is asserted (not
// just the count-mismatch behavior).
const state = vi.hoisted(() => ({
  workspaceOrg: "org-1" as string | null,
  counts: { appConnection: 0, secret: 0 },
  where: {
    appConnection: undefined as unknown,
    secret: undefined as unknown,
  },
}));

vi.mock("@onecli/db", () => ({
  Prisma: { JsonNull: "JsonNull" },
  db: {
    workspace: {
      findUnique: async () =>
        state.workspaceOrg ? { organizationId: state.workspaceOrg } : null,
    },
    appConnection: {
      count: async (args: { where: unknown }) => {
        state.where.appConnection = args.where;
        return state.counts.appConnection;
      },
    },
    secret: {
      count: async (args: { where: unknown }) => {
        state.where.secret = args.where;
        return state.counts.secret;
      },
    },
  },
}));

const { assertTargetsValid } = await import("./policy-service");

const orgScope = { scope: "organization" as const, organizationId: "org-1" };
const workspaceScope = { scope: "workspace" as const, workspaceId: "proj-1" };

describe("assertTargetsValid — no-op cases", () => {
  beforeEach(() => {
    state.workspaceOrg = "org-1";
    state.counts = { appConnection: 0, secret: 0 };
    state.where = { appConnection: undefined, secret: undefined };
  });

  it("passes with no targets", async () => {
    await expect(
      assertTargetsValid(workspaceScope, []),
    ).resolves.toBeUndefined();
  });

  it("passes with only app/network targets (no owned id)", async () => {
    await expect(
      assertTargetsValid(orgScope, [
        { kind: "app", provider: "github" },
        { kind: "network", hostPattern: "api.example.com" },
      ]),
    ).resolves.toBeUndefined();
    // Never queried — nothing to own.
    expect(state.where.appConnection).toBeUndefined();
    expect(state.where.secret).toBeUndefined();
  });
});

describe("assertTargetsValid — ownership (IDOR guard)", () => {
  beforeEach(() => {
    state.workspaceOrg = "org-1";
    state.counts = { appConnection: 0, secret: 0 };
    state.where = { appConnection: undefined, secret: undefined };
  });

  it("passes when every referenced connection/secret resolves in scope", async () => {
    state.counts = { appConnection: 1, secret: 1 };
    await expect(
      assertTargetsValid(workspaceScope, [
        { kind: "connection", connectionId: "c1" },
        { kind: "secret", secretId: "s1" },
      ]),
    ).resolves.toBeUndefined();
  });

  it("rejects a connection that does not resolve in the acting org", async () => {
    // count 0 ≠ 1 requested → foreign / missing.
    state.counts.appConnection = 0;
    await expect(
      assertTargetsValid(workspaceScope, [
        { kind: "connection", connectionId: "foreign" },
      ]),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("rejects a secret that does not resolve in the acting org", async () => {
    state.counts.secret = 0;
    await expect(
      assertTargetsValid(orgScope, [{ kind: "secret", secretId: "foreign" }]),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("rejects when only some referenced ids resolve (partial match)", async () => {
    state.counts.secret = 1; // own 1, request 2 → mismatch
    await expect(
      assertTargetsValid(orgScope, [
        { kind: "secret", secretId: "s1" },
        { kind: "secret", secretId: "s2" },
      ]),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("dedupes repeated ids before counting (same id twice = one)", async () => {
    // Two identical connection ids dedupe to one; count 1 === 1 requested.
    state.counts.appConnection = 1;
    await expect(
      assertTargetsValid(workspaceScope, [
        { kind: "connection", connectionId: "c1" },
        { kind: "connection", connectionId: "c1" },
      ]),
    ).resolves.toBeUndefined();
  });

  it("fails BAD_REQUEST when the workspace's org can't be resolved", async () => {
    state.workspaceOrg = null;
    await expect(
      assertTargetsValid(workspaceScope, [
        { kind: "connection", connectionId: "c1" },
      ]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("assertTargetsValid — level scope + secret XOR (step 8)", () => {
  beforeEach(() => {
    state.workspaceOrg = "org-1";
    state.counts = { appConnection: 0, secret: 0 };
    state.where = { appConnection: undefined, secret: undefined };
  });

  it("rejects a workspace rule scoping an app target to organization connections", async () => {
    await expect(
      assertTargetsValid(workspaceScope, [
        { kind: "app", provider: "gmail", connectionScope: "organization" },
      ]),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("rejects a workspace rule scoping a secret target to organization secrets", async () => {
    await expect(
      assertTargetsValid(workspaceScope, [
        { kind: "secret", secretScope: "organization" },
      ]),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("allows an org rule to scope an app/secret target to either level", async () => {
    await expect(
      assertTargetsValid(orgScope, [
        { kind: "app", provider: "gmail", connectionScope: "organization" },
        { kind: "app", provider: "slack", connectionScope: "workspace" },
        { kind: "secret", secretScope: "organization" },
        { kind: "secret", secretScope: "workspace" },
      ]),
    ).resolves.toBeUndefined();
    // A scope-based target names no owned id → never counted.
    expect(state.where.secret).toBeUndefined();
    expect(state.where.appConnection).toBeUndefined();
  });

  it("allows a workspace rule to scope to its own workspace level", async () => {
    await expect(
      assertTargetsValid(workspaceScope, [
        { kind: "app", provider: "gmail", connectionScope: "workspace" },
        { kind: "secret", secretScope: "workspace" },
      ]),
    ).resolves.toBeUndefined();
  });

  it("allows an app target carrying BOTH tools and a connectionScope (the tools-picker shape)", async () => {
    // The rule dialog's tools picker authors an "all connections" app target
    // narrowed to specific tools: tools decide matching, connectionScope drives
    // injection. Validation must accept the two together (no owned id to fence —
    // the provider + level are not references).
    await expect(
      assertTargetsValid(workspaceScope, [
        {
          kind: "app",
          provider: "gmail",
          tools: ["search_messages", "read_message"],
          connectionScope: "workspace",
        },
      ]),
    ).resolves.toBeUndefined();
    expect(state.where.appConnection).toBeUndefined();
  });

  it("rejects a secret target naming both a secret and a level", async () => {
    await expect(
      assertTargetsValid(orgScope, [
        { kind: "secret", secretId: "s1", secretScope: "organization" },
      ]),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("rejects a secret target naming neither a secret nor a level", async () => {
    await expect(
      assertTargetsValid(orgScope, [{ kind: "secret" }]),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });
});

describe("assertTargetsValid — scope fence (the query itself)", () => {
  beforeEach(() => {
    state.workspaceOrg = "org-1";
    state.counts = { appConnection: 1, secret: 1 };
    state.where = { appConnection: undefined, secret: undefined };
  });

  it("a workspace rule fences to its WORKSPACE-owned resources only (no org branch)", async () => {
    await assertTargetsValid(workspaceScope, [
      { kind: "secret", secretId: "s1" },
    ]);
    expect(state.where.secret).toMatchObject({
      id: { in: ["s1"] },
      workspaceId: "proj-1",
    });
    // Org-level resources are governed at the org level — no OR reaching up.
    expect(state.where.secret).not.toHaveProperty("OR");
  });

  it("rejects a workspace rule that references an org-level resource", async () => {
    // The workspace-only fence excludes an org-level id → the count can't match.
    state.counts.secret = 0;
    await expect(
      assertTargetsValid(workspaceScope, [
        { kind: "secret", secretId: "an-org-level-secret" },
      ]),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    expect(state.where.secret).toMatchObject({ workspaceId: "proj-1" });
    expect(state.where.secret).not.toHaveProperty("OR");
  });

  it("an org rule fences to org-level resources", async () => {
    await assertTargetsValid(orgScope, [
      { kind: "connection", connectionId: "c1" },
    ]);
    expect(state.where.appConnection).toMatchObject({
      id: { in: ["c1"] },
      organizationId: "org-1",
      scope: "organization",
    });
    // No workspace OR-branch on an org rule.
    expect(state.where.appConnection).not.toHaveProperty("OR");
  });
});
