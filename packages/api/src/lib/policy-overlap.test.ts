import { describe, expect, it } from "vitest";
import {
  findPolicyOverlaps,
  type OverlapRule,
  type OverlapTarget,
} from "./policy-overlap";

// The zero-false-positive contract: every WARN case here is provably dead;
// every MUST-NOT-WARN case is an undecidable (or simply non-dead) shape the
// analysis must stay silent on — precision over recall, always.

let seq = 0;
const rule = (over: Partial<OverlapRule>): OverlapRule => ({
  logicalId: `l${seq++}`,
  isDefault: false,
  enabled: true,
  priority: seq,
  name: `rule-${seq}`,
  action: "allow",
  requireApproval: false,
  rateLimit: null,
  rateLimitWindow: null,
  identities: [],
  targets: [net("api.example.com")],
  conditions: null,
  ...over,
});

const net = (
  hostPattern: string,
  pathPattern: string | null = null,
  method: string | null = null,
): OverlapTarget => ({ kind: "network", hostPattern, pathPattern, method });

const app = (
  provider: string,
  tools: string[],
  connectionScope: string | null = null,
): OverlapTarget => ({ kind: "app", provider, tools, connectionScope });

const kinds = (rules: OverlapRule[]) =>
  findPolicyOverlaps(rules).map((w) => `${w.logicalId}:${w.kind}`);

describe("findPolicyOverlaps — warns (provably dead)", () => {
  it("flags an identical later rule as duplicate (same verdict)", () => {
    const a = rule({ logicalId: "a", priority: 1 });
    const b = rule({ logicalId: "b", priority: 2 });
    const warnings = findPolicyOverlaps([a, b]);
    expect(warnings).toEqual([
      { logicalId: "b", kind: "duplicate", byLogicalId: "a", byName: a.name },
    ]);
  });

  it("flags an identical later rule with a different verdict as conflict", () => {
    const a = rule({ logicalId: "a", priority: 1, action: "allow" });
    const b = rule({ logicalId: "b", priority: 2, action: "block" });
    expect(kinds([a, b])).toEqual(["b:conflict"]);
  });

  it("a differing modifier (rate limit) is a conflict, not a duplicate", () => {
    const a = rule({ logicalId: "a", priority: 1 });
    const b = rule({
      logicalId: "b",
      priority: 2,
      rateLimit: 5,
      rateLimitWindow: "minute",
    });
    expect(kinds([a, b])).toEqual(["b:conflict"]);
  });

  it("input order is irrelevant — priority decides who is the earlier twin", () => {
    const late = rule({ logicalId: "late", priority: 9 });
    const early = rule({ logicalId: "early", priority: 1 });
    const warnings = findPolicyOverlaps([late, early]);
    expect(warnings[0]).toMatchObject({
      logicalId: "late",
      byLogicalId: "early",
    });
  });

  it("flags a rule shadowed by an earlier catch-all network rule", () => {
    const all = rule({ logicalId: "all", priority: 1, targets: [net("*")] });
    const narrow = rule({
      logicalId: "n",
      priority: 2,
      targets: [net("api.x.com", "/v1/*", "GET")],
    });
    expect(kinds([all, narrow])).toEqual(["n:shadowed"]);
  });

  it("a universal earlier target covers app targets (secret rules are injection-exempt)", () => {
    // The secret-target sibling is NOT flagged: it still injects at connect
    // even when its decision surface is covered (the truthfulness fence).
    const all = rule({ logicalId: "all", priority: 1, targets: [net("*")] });
    const appR = rule({
      logicalId: "app",
      priority: 2,
      targets: [app("github", ["t1"])],
    });
    const secretR = rule({
      logicalId: "sec",
      priority: 3,
      targets: [{ kind: "secret", secretId: "s1", secretScope: null }],
    });
    expect(kinds([all, appR, secretR])).toEqual(["app:shadowed"]);
  });

  it("a universal earlier target covers a bare whole-app rule", () => {
    // Empty tools + no connectionScope = a pure whole-app match rule (no
    // injection) — coverable like any match-only target.
    const all = rule({ logicalId: "all", priority: 1, targets: [net("*")] });
    const whole = rule({
      logicalId: "w",
      priority: 2,
      targets: [app("gmail", [])],
    });
    expect(kinds([all, whole])).toEqual(["w:shadowed"]);
  });

  it("a whole-app earlier target covers any same-provider app target", () => {
    // No tools = host-only on EVERY catalog host of the provider — a superset
    // of each tool's (host, path, method) surface.
    const whole = rule({
      logicalId: "w",
      priority: 1,
      targets: [app("github", [])],
    });
    const tooled = rule({
      logicalId: "t",
      priority: 2,
      targets: [app("github", ["create_issue"])],
    });
    expect(kinds([whole, tooled])).toEqual(["t:shadowed"]);
  });

  it("a connection-scoped earlier app target still covers (scope never affects matching)", () => {
    // The COVERER may carry a connectionScope — its match surface is the same;
    // only VICTIMS are injection-exempt.
    const scoped = rule({
      logicalId: "s",
      priority: 1,
      targets: [app("github", [], "project")],
    });
    const tooled = rule({
      logicalId: "t",
      priority: 2,
      targets: [app("github", ["create_issue"])],
    });
    expect(kinds([scoped, tooled])).toEqual(["t:shadowed"]);
  });

  it("a conditioned universal still covers a TOOLS-app victim (conditions honored there)", () => {
    // Positive control for the conditions-asymmetry guard: a tools-named app
    // target HONORS its rule's conditions, so the subset test is sound and the
    // conditioned catch-all provably covers it.
    const cond = [{ target: "body", operator: "contains", value: "x" }];
    const all = rule({
      logicalId: "all",
      priority: 1,
      targets: [net("*")],
      conditions: cond,
    });
    const tooled = rule({
      logicalId: "t",
      priority: 2,
      targets: [app("github", ["create_issue"])],
      conditions: cond,
    });
    expect(kinds([all, tooled])).toEqual(["t:shadowed"]);
  });

  it("a BLOCK rule with a secret target is warnable (blocks never inject)", () => {
    // The injection fence is action-refined: inject-select collects ALLOW
    // rules only, so a block-action secret rule under an unconditioned
    // catch-all is provably dead with zero injection — recall reclaimed.
    const all = rule({ logicalId: "all", priority: 1, targets: [net("*")] });
    const blockSec = rule({
      logicalId: "bs",
      priority: 2,
      action: "block",
      targets: [{ kind: "secret", secretId: "s1", secretScope: null }],
    });
    expect(kinds([all, blockSec])).toEqual(["bs:shadowed"]);
  });

  it("a same-action modifier conflict on an injection-bearing twin still warns", () => {
    // Both twins are ALLOW → identical injection contribution (idempotent
    // union) — the conflict (differing rate modifier) stays truthful.
    const a = rule({
      logicalId: "a",
      priority: 1,
      targets: [app("gmail", [], "project")],
    });
    const b = rule({
      logicalId: "b",
      priority: 2,
      targets: [app("gmail", [], "project")],
      rateLimit: 5,
      rateLimitWindow: "minute",
    });
    expect(kinds([a, b])).toEqual(["b:conflict"]);
  });

  it("flags a concrete later host covered by an earlier wildcard host", () => {
    const wild = rule({
      logicalId: "w",
      priority: 1,
      targets: [net("*.example.com")],
    });
    const exact = rule({
      logicalId: "e",
      priority: 2,
      targets: [net("api.example.com")],
    });
    expect(kinds([wild, exact])).toEqual(["e:shadowed"]);
  });

  it("flags app tools-subset shadow (same provider)", () => {
    const broad = rule({
      logicalId: "b",
      priority: 1,
      targets: [app("github", ["a", "b", "c"])],
    });
    const sub = rule({
      logicalId: "s",
      priority: 2,
      targets: [app("github", ["b"])],
    });
    expect(kinds([broad, sub])).toEqual(["s:shadowed"]);
  });

  it("empty earlier identities cover identity-scoped later rules", () => {
    const all = rule({
      logicalId: "all",
      priority: 1,
      targets: [net("api.x.com")],
    });
    const scoped = rule({
      logicalId: "s",
      priority: 2,
      identities: [{ type: "agent", id: "a1" }],
      targets: [net("api.x.com")],
    });
    expect(kinds([all, scoped])).toEqual(["s:shadowed"]);
  });

  it("literal identity superset covers", () => {
    const both = rule({
      logicalId: "b",
      priority: 1,
      identities: [
        { type: "agent", id: "a1" },
        { type: "agent", id: "a2" },
      ],
      targets: [net("api.x.com")],
    });
    const one = rule({
      logicalId: "o",
      priority: 2,
      identities: [{ type: "agent", id: "a1" }],
      targets: [net("api.x.com")],
    });
    expect(kinds([both, one])).toEqual(["o:shadowed"]);
  });

  it("an earlier rule with FEWER conditions covers one with more", () => {
    const loose = rule({ logicalId: "l", priority: 1, conditions: null });
    const tight = rule({
      logicalId: "t",
      priority: 2,
      conditions: [{ target: "body", operator: "contains", value: "x" }],
    });
    expect(kinds([loose, tight])).toEqual(["t:shadowed"]);
  });
});

describe("findPolicyOverlaps — must NOT warn (undecidable or not dead)", () => {
  it("group-membership inclusion is never assumed", () => {
    const group = rule({
      logicalId: "g",
      priority: 1,
      identities: [{ type: "group", id: "g1" }],
      targets: [net("api.x.com")],
    });
    const user = rule({
      logicalId: "u",
      priority: 2,
      identities: [{ type: "user", id: "u-in-g1" }],
      targets: [net("api.x.com")],
    });
    expect(findPolicyOverlaps([group, user])).toEqual([]);
  });

  it("identity-scoped earlier rule never covers an all-agents later rule", () => {
    const scoped = rule({
      logicalId: "s",
      priority: 1,
      identities: [{ type: "agent", id: "a1" }],
      targets: [net("api.x.com")],
    });
    const all = rule({
      logicalId: "all",
      priority: 2,
      targets: [net("api.x.com")],
    });
    expect(findPolicyOverlaps([scoped, all])).toEqual([]);
  });

  it("cross-kind app vs network is never compared", () => {
    const network = rule({
      logicalId: "n",
      priority: 1,
      targets: [net("api.github.com")],
    });
    const appR = rule({
      logicalId: "a",
      priority: 2,
      targets: [app("github", ["t"])],
    });
    expect(findPolicyOverlaps([network, appR])).toEqual([]);
  });

  it("wildcard-vs-wildcard host subsumption is skipped", () => {
    const outer = rule({
      logicalId: "o",
      priority: 1,
      targets: [net("*.example.com")],
    });
    const inner = rule({
      logicalId: "i",
      priority: 2,
      targets: [net("*.api.example.com")],
    });
    expect(findPolicyOverlaps([outer, inner])).toEqual([]);
  });

  it("wildcard-vs-wildcard path subsumption is skipped", () => {
    const outer = rule({
      logicalId: "o",
      priority: 1,
      targets: [net("api.x.com", "/v1/*")],
    });
    const inner = rule({
      logicalId: "i",
      priority: 2,
      targets: [net("api.x.com", "/v1/users/*")],
    });
    expect(findPolicyOverlaps([outer, inner])).toEqual([]);
  });

  it("secret targets are never covered by non-universal rules", () => {
    const host = rule({
      logicalId: "h",
      priority: 1,
      targets: [net("api.x.com")],
    });
    const secret = rule({
      logicalId: "s",
      priority: 2,
      targets: [{ kind: "secret", secretId: "s1", secretScope: null }],
    });
    expect(findPolicyOverlaps([host, secret])).toEqual([]);
  });

  it("a connection-scoped app rule is never a shadow victim (it injects)", () => {
    // Its decision surface IS covered here, but the rule still drives
    // credential injection at connect — flagging it "unreachable" would invite
    // deleting a rule with live effect (the truthfulness fence).
    const broad = rule({
      logicalId: "b",
      priority: 1,
      targets: [app("github", ["a", "b"])],
    });
    const scoped = rule({
      logicalId: "s",
      priority: 2,
      targets: [app("github", ["a"], "project")],
    });
    expect(findPolicyOverlaps([broad, scoped])).toEqual([]);
  });

  it("injection-bearing rules are never shadowed, even under a universal rule", () => {
    // All three shapes that inject at connect — an app-scoped, a connection,
    // and a secret target — stay unflagged below a catch-all (the fence; for
    // secrets this also pins the fix of the pre-existing mislead).
    const all = rule({ logicalId: "all", priority: 1, targets: [net("*")] });
    const appScoped = rule({
      logicalId: "as",
      priority: 2,
      targets: [app("gmail", [], "project")],
    });
    const conn = rule({
      logicalId: "c",
      priority: 3,
      targets: [{ kind: "connection", connectionId: "c1", tools: [] }],
    });
    const sec = rule({
      logicalId: "sec",
      priority: 4,
      targets: [{ kind: "secret", secretId: null, secretScope: "project" }],
    });
    expect(findPolicyOverlaps([all, appScoped, conn, sec])).toEqual([]);
  });

  it("a conditioned universal never claims a whole-app victim (conditions ignored there)", () => {
    // THE conditions-asymmetry counterexample (review-proven live): the
    // catch-all matches only its conditioned slice, while the bare whole-app
    // victim matches host-only with conditions IGNORED — a body without "x"
    // fires the "shadowed" rule. Both action variants must stay silent.
    const cond = [{ target: "body", operator: "contains", value: "x" }];
    for (const action of ["allow", "block"] as const) {
      const all = rule({
        logicalId: "all",
        priority: 1,
        targets: [net("*")],
        conditions: cond,
      });
      const whole = rule({
        logicalId: "w",
        priority: 2,
        action,
        targets: [app("gmail", [])],
        conditions: cond,
      });
      expect(findPolicyOverlaps([all, whole])).toEqual([]);
    }
  });

  it("a conditioned universal never claims a BLOCK connection-target victim", () => {
    // Fix-attacker counterexample: the block rule bears no injection (blocks
    // never inject) so the injection fence doesn't cover it, but its
    // connection target resolves at connect to a whole-app match that IGNORES
    // conditions — the conditioned catch-all covers only its conditioned
    // slice, so the victim fires live. Must stay silent.
    const cond = [{ target: "body", operator: "contains", value: "x" }];
    const all = rule({
      logicalId: "all",
      priority: 1,
      targets: [net("*")],
      conditions: cond,
    });
    const blockConn = rule({
      logicalId: "bc",
      priority: 2,
      action: "block",
      targets: [{ kind: "connection", connectionId: "c1", tools: [] }],
      conditions: cond,
    });
    expect(findPolicyOverlaps([all, blockConn])).toEqual([]);
  });

  it("an opposite-action conflict on an injection-bearing allow twin is fenced", () => {
    // A Block head contributes no injection; the Allow twin keeps injecting
    // (position-independent union) even though its verdict never applies —
    // flagging it would invite deleting live injection.
    const blockHead = rule({
      logicalId: "bh",
      priority: 1,
      action: "block",
      targets: [app("github", [], "project")],
    });
    const allowTwin = rule({
      logicalId: "at",
      priority: 2,
      action: "allow",
      targets: [app("github", [], "project")],
    });
    expect(findPolicyOverlaps([blockHead, allowTwin])).toEqual([]);
  });

  it("two rules on the same connection with DIFFERENT tools are not duplicates", () => {
    // Connection targets now carry tools (the narrowing shape); `targetEntry`
    // folds them into the sig, so different tool sets on the same connection are
    // distinct rules, never flagged duplicate.
    const a = rule({
      logicalId: "a",
      priority: 1,
      targets: [{ kind: "connection", connectionId: "c1", tools: ["read"] }],
    });
    const b = rule({
      logicalId: "b",
      priority: 2,
      targets: [{ kind: "connection", connectionId: "c1", tools: ["write"] }],
    });
    expect(findPolicyOverlaps([a, b])).toEqual([]);
  });

  it("a conditioned universal never claims a BLOCK connection-with-tools victim", () => {
    // The block connection rule bears no injection (blocks don't inject) but is
    // still fenced from shadow because it names a connection target; and even so,
    // a tool-narrowed connection HONORS conditions (the fan-out), so a
    // conditioned catch-all could never cover it. Must stay silent either way.
    const cond = [{ target: "body", operator: "contains", value: "x" }];
    const all = rule({
      logicalId: "all",
      priority: 1,
      targets: [net("*")],
      conditions: cond,
    });
    const blockConnTools = rule({
      logicalId: "bct",
      priority: 2,
      action: "block",
      targets: [
        { kind: "connection", connectionId: "c1", tools: ["create_issue"] },
      ],
      conditions: cond,
    });
    expect(findPolicyOverlaps([all, blockConnTools])).toEqual([]);
  });

  it("two whole-app rules differing only in connectionScope are not duplicates", () => {
    // Same match surface, but DIFFERENT injection pools (org vs project
    // connections) — deleting one would lose its injection level, so the
    // signature keeps the scope and stays silent.
    const org = rule({
      logicalId: "o",
      priority: 1,
      targets: [app("gmail", [], "organization")],
    });
    const proj = rule({
      logicalId: "p",
      priority: 2,
      targets: [app("gmail", [], "project")],
    });
    expect(findPolicyOverlaps([org, proj])).toEqual([]);
  });

  it("a git-receive-pack later path is not covered by a plain path superset", () => {
    const broad = rule({
      logicalId: "b",
      priority: 1,
      targets: [net("github.com", "/acme/*", "POST")],
    });
    const push = rule({
      logicalId: "p",
      priority: 2,
      targets: [net("github.com", "/acme/repo/git-receive-pack", "POST")],
    });
    expect(findPolicyOverlaps([broad, push])).toEqual([]);
  });

  it("an any-path any-method earlier target DOES cover git-receive-pack", () => {
    const all = rule({
      logicalId: "a",
      priority: 1,
      targets: [net("github.com")],
    });
    const push = rule({
      logicalId: "p",
      priority: 2,
      targets: [net("github.com", "/acme/repo/git-receive-pack", "POST")],
    });
    expect(kinds([all, push])).toEqual(["p:shadowed"]);
  });

  it("a method-narrowed earlier rule never covers an any-method later rule", () => {
    const get = rule({
      logicalId: "g",
      priority: 1,
      targets: [net("api.x.com", null, "GET")],
    });
    const any = rule({
      logicalId: "a",
      priority: 2,
      targets: [net("api.x.com")],
    });
    expect(findPolicyOverlaps([get, any])).toEqual([]);
  });

  it("an earlier rule with MORE conditions never covers a looser one", () => {
    const tight = rule({
      logicalId: "t",
      priority: 1,
      conditions: [{ target: "body", operator: "contains", value: "x" }],
    });
    const loose = rule({ logicalId: "l", priority: 2, conditions: null });
    expect(findPolicyOverlaps([tight, loose])).toEqual([]);
  });

  it("disabled rules neither warn nor shadow", () => {
    const disabledAll = rule({
      logicalId: "d",
      priority: 1,
      enabled: false,
      targets: [net("*")],
    });
    const later = rule({ logicalId: "x", priority: 2 });
    const disabledDup = rule({ logicalId: "y", priority: 3, enabled: false });
    expect(findPolicyOverlaps([disabledAll, later, disabledDup])).toEqual([]);
  });

  it("the Default Rule is excluded on both sides", () => {
    const def = rule({
      logicalId: "def",
      priority: 99,
      isDefault: true,
      targets: [],
    });
    const r = rule({ logicalId: "r", priority: 1 });
    expect(findPolicyOverlaps([def, r])).toEqual([]);
  });

  it("an allow connection-target rule is never a shadow victim (injection-bearing shape)", () => {
    // Its provider resolves only at connect (statically unknowable) AND the
    // shape names a credential to inject — both reasons to stay silent under a
    // catch-all. (The fence is shape+action-based: whether THIS rule's
    // identities inject for a given agent is a runtime question.)
    const all = rule({ logicalId: "a", priority: 1, targets: [net("*")] });
    const conn = rule({
      logicalId: "i",
      priority: 2,
      targets: [{ kind: "connection", connectionId: "c1", tools: [] }],
    });
    expect(findPolicyOverlaps([all, conn])).toEqual([]);
  });

  it("a tools-named app target never covers a whole-app one (narrower)", () => {
    // The whole-app later rule matches EVERY catalog host of the provider on
    // any path/method — a single tool's fan-out cannot cover that.
    const tooled = rule({
      logicalId: "t",
      priority: 1,
      targets: [app("github", ["t"])],
    });
    const whole = rule({
      logicalId: "w",
      priority: 2,
      targets: [app("github", [])],
    });
    expect(findPolicyOverlaps([tooled, whole])).toEqual([]);
  });

  it("a whole-app target never covers a different provider", () => {
    const gmail = rule({
      logicalId: "g",
      priority: 1,
      targets: [app("gmail", [])],
    });
    const github = rule({
      logicalId: "h",
      priority: 2,
      targets: [app("github", [])],
    });
    // Even overlapping real-world host sets (shared provider hosts) are not
    // assumed — provider equality is the only sound app↔app bridge.
    expect(findPolicyOverlaps([gmail, github])).toEqual([]);
  });
});

describe("findPolicyOverlaps — soundness guards (review pass)", () => {
  it("does not fold Unicode hosts — ASCII-distinct patterns never claim cover", () => {
    // KELVIN SIGN (U+212A) lowercases to ASCII "k" under JS toLowerCase, but
    // the real matcher folds ASCII-only — these two hosts are DISJOINT live.
    const ascii = rule({
      logicalId: "a",
      priority: 1,
      targets: [net("api.kraken.com")],
    });
    const kelvin = rule({
      logicalId: "k",
      priority: 2,
      targets: [net("api.Kraken.com")],
    });
    expect(findPolicyOverlaps([ascii, kelvin])).toEqual([]);
  });

  it("treats malformed conditions as matches-all on both sides", () => {
    // Malformed r1 (= matches unconditionally) covers a conditioned r2 …
    const malformed = rule({
      logicalId: "m",
      priority: 1,
      conditions: "not-an-array",
    });
    const tight = rule({
      logicalId: "t",
      priority: 2,
      conditions: [{ target: "body", operator: "contains", value: "x" }],
    });
    expect(kinds([malformed, tight])).toEqual(["t:shadowed"]);

    // … but a conditioned r1 never covers a malformed (matches-all) r2.
    const tightFirst = rule({
      logicalId: "tf",
      priority: 1,
      conditions: [{ target: "body", operator: "contains", value: "x" }],
    });
    const malformedLater = rule({
      logicalId: "ml",
      priority: 2,
      conditions: [{ broken: true }],
    });
    expect(findPolicyOverlaps([tightFirst, malformedLater])).toEqual([]);
  });

  it("git samePath with mismatched methods must not warn", () => {
    const get = rule({
      logicalId: "g",
      priority: 1,
      targets: [net("github.com", "/acme/repo/git-receive-pack", "GET")],
    });
    const post = rule({
      logicalId: "p",
      priority: 2,
      targets: [net("github.com", "/acme/repo/git-receive-pack", "POST")],
    });
    expect(findPolicyOverlaps([get, post])).toEqual([]);
  });

  it("secret targets never cover other secret targets", () => {
    const s1 = rule({
      logicalId: "s1",
      priority: 1,
      targets: [{ kind: "secret", secretId: "same", secretScope: null }],
    });
    const s2 = rule({
      logicalId: "s2",
      priority: 2,
      targets: [{ kind: "secret", secretId: "other", secretScope: null }],
    });
    expect(findPolicyOverlaps([s1, s2])).toEqual([]);
  });

  it('isUniversal accepts pathPattern "*" like null', () => {
    const universal = rule({
      logicalId: "u",
      priority: 1,
      targets: [net("*", "*")],
    });
    const appR = rule({
      logicalId: "a",
      priority: 2,
      targets: [app("github", ["t"])],
    });
    expect(kinds([universal, appR])).toEqual(["a:shadowed"]);
  });
});
