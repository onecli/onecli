import { describe, expect, it } from "vitest";
import { diffPolicyChanges, type DiffableRule } from "./policy-diff";

// The staged-changes diff the policy editor renders (count badge, row chips,
// the Review-changes dialog). Custom rules + the Default action only — derived
// churn must be invisible.

let seq = 0;
const rule = (over: Partial<DiffableRule>): DiffableRule => ({
  logicalId: `l${seq++}`,
  source: "custom",
  isDefault: false,
  priority: 0,
  name: "rule",
  description: null,
  action: "allow",
  enabled: true,
  requireApproval: false,
  rateLimit: null,
  rateLimitWindow: null,
  identities: [],
  targets: [{ kind: "network", hostPattern: "a.com" }],
  conditions: null,
  ...over,
});

describe("diffPolicyChanges", () => {
  it("classifies added / changed / removed by logicalId, with row states", () => {
    const kept = rule({ logicalId: "keep", name: "kept", priority: 0 });
    const edited = rule({ logicalId: "edit", name: "edited", priority: 1 });
    const editedDraft = { ...edited, action: "block" as const };
    const gone = rule({ logicalId: "gone", name: "old", priority: 2 });
    const fresh = rule({ logicalId: "new", name: "brand new", priority: 3 });

    const diff = diffPolicyChanges(
      [kept, editedDraft, fresh],
      [kept, edited, gone],
      { action: "allow" },
      { action: "allow" },
    );

    expect(diff.added.map((c) => c.logicalId)).toEqual(["new"]);
    expect(diff.changed.map((c) => c.logicalId)).toEqual(["edit"]);
    expect(diff.changed[0]!.details).toEqual(["Action: Allow → Block"]);
    expect(diff.removed.map((c) => c.logicalId)).toEqual(["gone"]);
    expect(diff.defaultChange).toBeNull();
    expect(diff.reordered).toBe(false);
    expect(diff.count).toBe(3);
    expect(diff.rowState.get("new")).toBe("new");
    expect(diff.rowState.get("edit")).toBe("changed");
    expect(diff.rowState.has("keep")).toBe(false);
  });

  it("ignores blocklist rows — written by their own surface in lockstep", () => {
    // The app page's blocklist panel writes draft and published together and the
    // console gives those rows no actions, so they can never be pending.
    const blocklist = rule({ logicalId: "d1", source: "blocklist" });
    const diff = diffPolicyChanges(
      [blocklist],
      [rule({ logicalId: "d2", source: "blocklist" })],
      { action: "allow" },
      { action: "allow" },
    );
    expect(diff.count).toBe(0);
  });

  it("COUNTS a staged revoke of a legacy app_permission rule", () => {
    // The App Permissions editor is gone and the adoption pass that re-tagged
    // these to `custom` retired with it, so on an un-adopted instance such a row
    // still DECIDES and the policy console is the only place to switch it off.
    // If the diff ignored it, "Apply Changes" would stay greyed out and the
    // change could never reach the gateway.
    const legacy = rule({ logicalId: "ap1", source: "app_permission" });
    const diff = diffPolicyChanges(
      [{ ...legacy, enabled: false }],
      [legacy],
      { action: "allow" },
      { action: "allow" },
    );
    expect(diff.count).toBe(1);
    expect(diff.rowState.get("ap1")).toBe("changed");
  });

  it("COUNTS a staged revoke of a credential grant", () => {
    // Equipment rows are the credential grants, revocable from the console since
    // step 10. If the diff ignored them, "Apply Changes" would stay greyed out
    // and a revoke could never reach the gateway — it would look done and do
    // nothing.
    const granted = rule({ logicalId: "eq1", source: "equipment" });
    const diff = diffPolicyChanges(
      [{ ...granted, enabled: false }],
      [granted],
      { action: "allow" },
      { action: "allow" },
    );
    expect(diff.count).toBe(1);
    expect(diff.rowState.get("eq1")).toBe("changed");
    expect(diff.changed[0]?.details).toContain("Disabled");
  });

  it("COUNTS a deleted credential grant", () => {
    const granted = rule({ logicalId: "eq1", source: "equipment" });
    const diff = diffPolicyChanges(
      [],
      [granted],
      { action: "allow" },
      { action: "allow" },
    );
    expect(diff.count).toBe(1);
    expect(diff.removed[0]?.logicalId).toBe("eq1");
  });

  it("reports a pure reorder as one change", () => {
    const a = rule({ logicalId: "a", priority: 0 });
    const b = rule({ logicalId: "b", priority: 1 });
    const diff = diffPolicyChanges(
      [
        { ...a, priority: 1 },
        { ...b, priority: 0 },
      ],
      [a, b],
      { action: "allow" },
      { action: "allow" },
    );
    expect(diff.added).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.reordered).toBe(true);
    expect(diff.count).toBe(1);
  });

  it("reports a reorder and an edit independently when combined", () => {
    const a = rule({ logicalId: "a", priority: 0 });
    const b = rule({ logicalId: "b", priority: 1 });
    const diff = diffPolicyChanges(
      [
        { ...b, priority: 0, action: "block" },
        { ...a, priority: 1 },
      ],
      [a, b],
      { action: "allow" },
      { action: "allow" },
    );
    expect(diff.reordered).toBe(true);
    expect(diff.changed.map((c) => c.logicalId)).toEqual(["b"]);
    expect(diff.count).toBe(2);
  });

  it("does not call an insertion between rules a reorder", () => {
    // A new rule lands between two kept ones — the KEPT rules' relative order
    // is unchanged, so this is an add, not a reorder.
    const a = rule({ logicalId: "a", priority: 0 });
    const b = rule({ logicalId: "b", priority: 1 });
    const inserted = rule({ logicalId: "mid", priority: 1 });
    const diff = diffPolicyChanges(
      [a, { ...inserted }, { ...b, priority: 2 }],
      [a, b],
      { action: "allow" },
      { action: "allow" },
    );
    expect(diff.added.map((c) => c.logicalId)).toEqual(["mid"]);
    expect(diff.reordered).toBe(false);
    expect(diff.count).toBe(1);
  });

  it("reports the Default Rule action change", () => {
    const diff = diffPolicyChanges(
      [],
      [],
      { action: "block" },
      { action: "allow" },
    );
    expect(diff.defaultChange).toEqual({ from: "allow", to: "block" });
    expect(diff.count).toBe(1);
  });

  it("stays quiet while a default is still loading (undefined)", () => {
    const diff = diffPolicyChanges([], [], undefined, { action: "allow" });
    expect(diff.defaultChange).toBeNull();
    expect(diff.count).toBe(0);
  });

  it("describes multi-field edits compactly", () => {
    const before = rule({
      logicalId: "x",
      name: "old name",
      requireApproval: false,
      rateLimit: null,
      rateLimitWindow: null,
    });
    const after = {
      ...before,
      name: "new name",
      requireApproval: true,
      rateLimit: 5,
      rateLimitWindow: "minute",
      identities: [{ type: "agent", id: "a1" }],
    };
    const diff = diffPolicyChanges([after], [before], undefined, undefined);
    expect(diff.changed[0]!.details).toEqual([
      "Renamed from “old name”",
      "Applies-to edited",
      "Now requires approval",
      "Rate limit: none → 5/minute",
    ]);
  });

  it("a description-only edit is a change (the dialog must enumerate everything Apply publishes)", () => {
    const before = rule({ logicalId: "x", description: null });
    const after = { ...before, description: "why this rule exists" };
    const diff = diffPolicyChanges([after], [before], undefined, undefined);
    expect(diff.changed[0]!.details).toEqual(["Description edited"]);
    expect(diff.count).toBe(1);
  });

  it("identity order does not count as a change", () => {
    const before = rule({
      logicalId: "x",
      identities: [
        { type: "agent", id: "a1" },
        { type: "agent", id: "a2" },
      ],
    });
    const after = {
      ...before,
      identities: [
        { type: "agent", id: "a2" },
        { type: "agent", id: "a1" },
      ],
    };
    const diff = diffPolicyChanges([after], [before], undefined, undefined);
    expect(diff.count).toBe(0);
  });
});
