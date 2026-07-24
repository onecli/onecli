import { describe, expect, it } from "vitest";
import {
  buildRematerializedPublishSet,
  publishSetSignature,
  type PolicyRuleRow,
} from "./policy-service";

// The staged-publish bridge fix, tested over the PURE halves: the publish set
// is built from the CURRENT PUBLISHED generation's KEPT rows (the complement of
// the derived-source list) plus the fresh derived rows — the draft (with any
// staged edits) never enters — and the behavior signature decides whether
// re-publishing is a no-op.

// The two eras of the derived-source list (`bridgeDerivedSources`): pre-cutover
// (editing off — OSS + legacy cloud) vs post-adoption (editing on).
const LEGACY_DERIVED = ["app_permission", "blocklist", "equipment"];
const ADOPTED_DERIVED = ["blocklist", "equipment"];

let seq = 0;
const row = (over: Partial<PolicyRuleRow>): PolicyRuleRow => ({
  id: `r${seq++}`,
  scope: "organization",
  organizationId: "org1",
  projectId: null,
  status: "published",
  generation: 3,
  priority: 0,
  enabled: true,
  isDefault: false,
  logicalId: `l${seq}`,
  source: "custom",
  name: "rule",
  description: null,
  action: "allow",
  rateLimit: null,
  rateLimitWindow: null,
  requireApproval: false,
  conditions: null,
  createdByUserId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  identities: [],
  targets: [],
  ...over,
});

const target = (
  over: Partial<PolicyRuleRow["targets"][number]>,
): PolicyRuleRow["targets"][number] => ({
  id: `t${seq++}`,
  ruleId: "r",
  kind: "network",
  appProvider: null,
  appTools: [],
  appConnectionScope: null,
  appConnectionId: null,
  secretId: null,
  secretScope: null,
  hostPattern: "example.com",
  pathPattern: null,
  method: null,
  ...over,
});

const identity = (
  over: Partial<PolicyRuleRow["identities"][number]>,
): PolicyRuleRow["identities"][number] => ({
  id: `i${seq++}`,
  ruleId: "r",
  agentId: null,
  agentGroupId: null,
  userId: null,
  groupId: null,
  ...over,
});

describe("buildRematerializedPublishSet", () => {
  it("keeps published customs (re-prioritized) + default, drops old derived, appends fresh derived", () => {
    const publishedCustom = row({ id: "pc", source: "custom", priority: 1 });
    const publishedDefault = row({
      id: "pd",
      source: "default",
      isDefault: true,
      action: "block",
      priority: 0,
    });
    const oldDerived = row({ id: "od", source: "blocklist", priority: 2 });
    const oldEquipment = row({ id: "oe", source: "equipment", priority: 3 });
    const fresh = row({ id: "fd", source: "blocklist", priority: 0 });

    const set = buildRematerializedPublishSet(
      [publishedDefault, publishedCustom, oldDerived, oldEquipment],
      [{ id: "pc", priority: 2 }],
      [{ row: fresh, publishPriority: 1 }],
      LEGACY_DERIVED,
    );

    // The default lands one slot past every explicit priority (max 2 → 3) —
    // unique by construction, so read-back ordering can never tie on it.
    expect(set.map((r) => [r.id, r.source, r.priority])).toEqual([
      ["pd", "default", 3],
      ["pc", "custom", 2],
      ["fd", "blocklist", 1],
    ]);
  });

  it("normalizes the carried default's priority past a would-be tie", () => {
    const tiedDefault = row({
      id: "pd",
      source: "default",
      isDefault: true,
      priority: 1,
    });
    const custom = row({ id: "pc", source: "custom", priority: 1 });
    const set = buildRematerializedPublishSet(
      [tiedDefault, custom],
      [{ id: "pc", priority: 1 }],
      [],
      LEGACY_DERIVED,
    );
    expect(set.map((r) => [r.id, r.priority])).toEqual([
      ["pd", 2],
      ["pc", 1],
    ]);
  });

  it("a never-published scope yields fresh derived only (no default is invented)", () => {
    const fresh = row({ source: "app_permission" });
    const set = buildRematerializedPublishSet(
      [],
      [],
      [{ row: fresh, publishPriority: 0 }],
      LEGACY_DERIVED,
    );
    expect(set.map((r) => r.source)).toEqual(["app_permission"]);
  });

  it("a published custom missing from the plan keeps its own priority", () => {
    const custom = row({ id: "pc", source: "custom", priority: 7 });
    const set = buildRematerializedPublishSet([custom], [], [], LEGACY_DERIVED);
    expect(set.map((r) => r.priority)).toEqual([7]);
  });

  // ── Post-adoption era (editing on): app_permission is KEPT, not derived ──

  it("post-adoption keeps straggler app_permission rows verbatim instead of dropping them", () => {
    const straggler = row({ id: "ap", source: "app_permission", priority: 0 });
    const custom = row({ id: "pc", source: "custom", priority: 1 });
    const equipment = row({ id: "oe", source: "equipment", priority: 2 });

    // LEGACY: the app_permission row is derived-owned → dropped from the set
    // (the fresh derive re-creates it). ADOPTED: it is kept — dropping it with
    // nothing re-deriving it would silently delete the rule (fail-open).
    const legacy = buildRematerializedPublishSet(
      [straggler, custom, equipment],
      [{ id: "pc", priority: 1 }],
      [],
      LEGACY_DERIVED,
    );
    expect(legacy.map((r) => r.id)).toEqual(["pc"]);

    const adopted = buildRematerializedPublishSet(
      [straggler, custom, equipment],
      [
        { id: "ap", priority: 0 },
        { id: "pc", priority: 1 },
      ],
      [],
      ADOPTED_DERIVED,
    );
    expect(adopted.map((r) => [r.id, r.priority])).toEqual([
      ["ap", 0],
      ["pc", 1],
    ]);
  });

  it("post-adoption a kept app_permission row re-prioritized via the plan never collides (no duplicate priorities)", () => {
    // The adversarially-found 5th-site failure shape: a kept AP row absent from
    // the priority plan keeps a stale absolute priority that can collide with a
    // re-densified custom. With the plan supplying its priority (the coherence
    // publish-interleave includes kept AP rows), all priorities stay unique.
    const ap = row({ id: "ap", source: "app_permission", priority: 5 });
    const custom = row({ id: "pc", source: "custom", priority: 9 });
    const freshBlocklist = row({ id: "fb", source: "blocklist", priority: 0 });

    const set = buildRematerializedPublishSet(
      [ap, custom],
      [
        { id: "ap", priority: 0 },
        { id: "pc", priority: 1 },
      ],
      [{ row: freshBlocklist, publishPriority: 2 }],
      ADOPTED_DERIVED,
    );
    const priorities = set.map((r) => r.priority);
    expect(new Set(priorities).size).toBe(priorities.length);
    expect(set.map((r) => [r.id, r.priority])).toEqual([
      ["ap", 0],
      ["pc", 1],
      ["fb", 2],
    ]);
  });
});

describe("publishSetSignature", () => {
  const network = (host: string) => [target({ hostPattern: host })];

  it("ignores ids, logicalIds, timestamps, and the publish author (derived churn is a no-op)", () => {
    const a = row({
      id: "a",
      logicalId: "la",
      source: "blocklist",
      action: "block",
      targets: network("x.com"),
      createdByUserId: "u1",
    });
    const b = row({
      id: "b",
      logicalId: "lb",
      source: "blocklist",
      action: "block",
      targets: network("x.com"),
      createdByUserId: null,
      createdAt: new Date(999),
    });
    expect(publishSetSignature([a])).toBe(publishSetSignature([b]));
  });

  it("is invariant under absolute-priority renumbering that preserves order", () => {
    const r1 = (p: number) =>
      row({
        source: "custom",
        name: "one",
        priority: p,
        targets: network("a.com"),
      });
    const r2 = (p: number) =>
      row({
        source: "blocklist",
        name: "two",
        priority: p,
        targets: network("b.com"),
      });
    expect(publishSetSignature([r1(0), r2(1)])).toBe(
      publishSetSignature([r1(3), r2(9)]),
    );
    // …but an ORDER change is a real change.
    expect(publishSetSignature([r1(0), r2(1)])).not.toBe(
      publishSetSignature([r1(9), r2(3)]),
    );
  });

  it("detects a derived behavior change (action, target, modifier)", () => {
    const base = () =>
      row({ source: "app_permission", targets: network("api.com") });
    expect(publishSetSignature([base()])).not.toBe(
      publishSetSignature([{ ...base(), action: "block" }]),
    );
    expect(publishSetSignature([base()])).not.toBe(
      publishSetSignature([{ ...base(), targets: network("other.com") }]),
    );
    expect(publishSetSignature([base()])).not.toBe(
      publishSetSignature([{ ...base(), requireApproval: true }]),
    );
  });

  it("the Default Rule's position never affects the signature (flag-selected, era-varying priority)", () => {
    const explicit = row({
      source: "custom",
      name: "explicit",
      priority: 1,
      targets: [target({ hostPattern: "x.com" })],
    });
    const defaultFirst = row({
      source: "default",
      isDefault: true,
      action: "block",
      priority: 0,
    });
    const defaultLast = { ...defaultFirst, priority: 9 };
    expect(publishSetSignature([defaultFirst, explicit])).toBe(
      publishSetSignature([explicit, defaultLast]),
    );
  });

  it("canonicalizes identity and target order within a rule", () => {
    const i1 = identity({ agentId: "a1" });
    const i2 = identity({ agentId: "a2" });
    const t1 = target({ hostPattern: "a.com" });
    const t2 = target({ hostPattern: "b.com" });
    const forward = row({ identities: [i1, i2], targets: [t1, t2] });
    const reversed = row({ identities: [i2, i1], targets: [t2, t1] });
    expect(publishSetSignature([forward])).toBe(
      publishSetSignature([reversed]),
    );
  });

  it("a staged draft edit does not change the publish signature (structural: the draft never enters the set)", () => {
    // The publish set is BUILT from publishedRows + freshDerived only — there is
    // no draft input. This pins the builder's signature over a realistic set.
    const published = [
      row({ source: "default", isDefault: true, action: "block", priority: 0 }),
      row({
        source: "custom",
        name: "keep-me",
        priority: 1,
        targets: network("k.com"),
      }),
    ];
    const fresh = row({
      source: "blocklist",
      priority: 0,
      targets: network("d.com"),
    });
    const set = buildRematerializedPublishSet(
      published,
      [{ id: published[1]!.id, priority: 1 }],
      [{ row: fresh, publishPriority: 2 }],
      LEGACY_DERIVED,
    );
    // Identical inputs → identical signature, regardless of any draft state.
    const again = buildRematerializedPublishSet(
      published,
      [{ id: published[1]!.id, priority: 1 }],
      [{ row: fresh, publishPriority: 2 }],
      LEGACY_DERIVED,
    );
    expect(publishSetSignature(set)).toBe(publishSetSignature(again));
  });
});
