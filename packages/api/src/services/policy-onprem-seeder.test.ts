import { beforeEach, describe, expect, it, vi } from "vitest";

// The onprem new-workspace birth posture, which shipped with ZERO coverage while it
// was derived from the oldest workspace's published default. Attach-model step 6
// pins it to ALLOW: the workspace Default Rule has no UI any more, so an
// inherited Block would be both invisible and unfixable — every new workspace
// would silently be allowlist-mode. The `db` mock is deliberately a landmine:
// the seeder must not read the database at all now, so any query fails loudly
// rather than quietly reintroducing the derivation.

const state = vi.hoisted(() => ({
  calls: [] as { scope: unknown; rules: Record<string, unknown>[] }[],
}));

vi.mock("./policy-service", () => ({
  backfillPublishScope: async (
    scope: unknown,
    rules: Record<string, unknown>[],
  ) => {
    state.calls.push({ scope, rules });
    return { skipped: false, generation: 1, ruleCount: rules.length };
  },
}));

vi.mock("@onecli/db", () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error(
          "the onprem workspace seeder must not query the database — its posture is pinned to allow",
        );
      },
    },
  ),
}));

const { onpremNewWorkspacePolicySeeder } =
  await import("./policy-onprem-seeder");

beforeEach(() => {
  state.calls = [];
});

describe("the onprem new-workspace seeded posture", () => {
  it("seeds exactly one workspace Default Rule with action ALLOW", async () => {
    await onpremNewWorkspacePolicySeeder.seed("org-x", "proj-1");
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.scope).toEqual({ workspaceId: "proj-1" });
    expect(state.calls[0]?.rules).toHaveLength(1);
    expect(state.calls[0]?.rules[0]).toMatchObject({
      isDefault: true,
      source: "default",
      name: "Default Rule",
      action: "allow",
      priority: 0,
      requireApproval: false,
      identities: [],
      targets: [],
    });
  });

  it("stays ALLOW no matter what exists already — no instance-posture inheritance", async () => {
    // Previously this read the oldest workspace's published default, so one
    // operator flipping their first workspace to Block made every later workspace
    // deny-by-default forever. The db mock above proves no such read happens.
    await onpremNewWorkspacePolicySeeder.seed("org-x", "proj-2");
    await onpremNewWorkspacePolicySeeder.seed("org-x", "proj-3");
    expect(state.calls.map((c) => c.rules[0]?.action)).toEqual([
      "allow",
      "allow",
    ]);
  });

  it("no-ops for an org-only call — the onprem edition has no org scope", async () => {
    await onpremNewWorkspacePolicySeeder.seed("org-x");
    expect(state.calls).toHaveLength(0);
  });
});
