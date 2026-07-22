import { asciiLower, hostMatches, pathMatches } from "./path-match";

// Overlap/shadow analysis for the manually-ordered first-match policy list.
// ZERO-FALSE-POSITIVE by construction: a warning is emitted only when it is
// PROVABLE from the literal rule data that the later rule can never take
// effect — every undecidable comparison (group-membership inclusion, app↔network
// cross-kind, wildcard⊇wildcard patterns, secret host sets, org↔project
// cross-level) is skipped, costing recall but never precision. The match
// semantics mirrored here are the engine's (evaluate.rs):
// first match in priority order wins; empty identities = any principal; empty
// targets match nothing; an empty-tools app target is the WHOLE app (host-only
// on the provider's catalog hosts); a connection target resolves at connect to
// its provider's whole app (statically unknowable here).
//
// TRUTHFULNESS FENCE: an ALLOW rule with an INJECTION-BEARING target (a
// connection, a secret, or an app target with a connectionScope) is never
// reported `shadowed` — even when its DECISION surface is provably covered,
// the rule still drives credential injection at connect (inject-select unions
// ALLOW rules position-independently), so "can never apply" would invite
// deleting a rule with live effect. `duplicate` still applies (an identical
// signature implies the identical action and injection contribution — the
// injection union is idempotent), and so does a same-action `conflict`
// (modifier-only); a conflict under an OPPOSITE-action head is fenced too,
// since the block head contributes no injection while the allow victim does.
// Known caveat, unreachable via current callers: a connection target's
// injected sessionPolicy is the rule's RAW conditions while the signature
// canonicalizes them (sorted/deduped) — set-equal-but-raw-different twins
// would be called duplicates; the editor excludes equipment rules (the only
// sessionPolicy-shaped carriers) and custom conditions are Zod-shaped, where
// order/duplication are semantically inert.
//
// CONDITIONS ASYMMETRY GUARD: whole-app (empty-tools app) and secret targets
// match with rule conditions IGNORED, while network/tools targets honor them.
// A conditioned coverer therefore matches only its conditioned slice and can
// never prove cover over a conditions-ignoring victim — such a victim is
// claimable only by coverers with NO conditions (`ruleCovers`). Connection
// targets are treated as conditions-ignoring too — CONSERVATIVELY (a tool-
// narrowed connection actually honors conditions), which is safe because a
// connection rule is injection-bearing and thus never a shadow VICTIM anyway;
// the classification only ever suppresses, never mis-warns.

/** The structural slice the analysis reads — `PolicyRuleV2`/`PolicyRuleDto`
 * satisfy it as-is (mirrors `DiffableRule`, with typed targets). */
export interface OverlapRule {
  logicalId: string;
  isDefault: boolean;
  enabled: boolean;
  priority: number;
  name: string;
  action: "allow" | "block";
  requireApproval: boolean;
  rateLimit: number | null;
  rateLimitWindow: string | null;
  identities: { type: string; id: string }[];
  targets: OverlapTarget[];
  conditions: unknown;
}

export type OverlapTarget =
  | {
      kind: "app";
      provider: string;
      tools: string[];
      connectionScope: string | null;
    }
  | { kind: "connection"; connectionId: string; tools: string[] }
  | { kind: "secret"; secretId: string | null; secretScope: string | null }
  | {
      kind: "network";
      hostPattern: string;
      pathPattern: string | null;
      method: string | null;
    };

export interface OverlapWarning {
  /** The rule that can never take effect. */
  logicalId: string;
  /**
   * duplicate — an identical earlier rule with the same verdict (redundant);
   * conflict — an identical earlier rule with a DIFFERENT verdict (the later
   * verdict never applies); shadowed — a broader earlier rule matches
   * everything this rule matches, so it is never reached.
   */
  kind: "duplicate" | "conflict" | "shadowed";
  /** The earlier rule responsible. */
  byLogicalId: string;
  byName: string;
}

// ── Canonical signatures (duplicate detection) ──────────────────────────────

const identitySig = (r: OverlapRule): string =>
  r.identities
    .map((i) => `${i.type}:${i.id}`)
    .sort()
    .join(",");

const targetEntry = (t: OverlapTarget): string => {
  switch (t.kind) {
    case "app":
      return `app|${t.provider}|${[...t.tools].sort().join("+")}|${t.connectionScope ?? ""}`;
    case "connection":
      return `connection|${t.connectionId}|${[...t.tools].sort().join("+")}`;
    case "secret":
      return `secret|${t.secretId ?? ""}|${t.secretScope ?? ""}`;
    case "network":
      return `network|${t.hostPattern}|${t.pathPattern ?? ""}|${t.method ?? ""}`;
  }
};

const targetSig = (r: OverlapRule): string =>
  r.targets.map(targetEntry).sort().join(",");

/**
 * Canonical condition set, mirroring the gateway's all-or-nothing
 * `parse_conditions`: a non-array, or ANY element missing target/operator/value
 * strings, makes the WHOLE conditions match unconditionally (= empty set).
 */
const conditionSet = (conditions: unknown): Set<string> => {
  if (!Array.isArray(conditions)) return new Set();
  const entries: string[] = [];
  for (const c of conditions) {
    if (
      typeof c !== "object" ||
      c === null ||
      typeof (c as Record<string, unknown>).target !== "string" ||
      typeof (c as Record<string, unknown>).operator !== "string" ||
      typeof (c as Record<string, unknown>).value !== "string"
    ) {
      return new Set();
    }
    const e = c as { target: string; operator: string; value: string };
    entries.push(`${e.target}|${e.operator}|${e.value}`);
  }
  return new Set(entries);
};

const conditionSig = (r: OverlapRule): string =>
  [...conditionSet(r.conditions)].sort().join(",");

const matchSig = (r: OverlapRule): string =>
  `${identitySig(r)}\n${targetSig(r)}\n${conditionSig(r)}`;

const verdictSig = (r: OverlapRule): string =>
  `${r.action}|${r.requireApproval}|${r.rateLimit ?? ""}|${r.rateLimitWindow ?? ""}`;

// ── Sound cover rules (shadow detection) ────────────────────────────────────

/** Identical entries behave identically, so a subset of AND-ed conditions
 * matches a superset of requests — sound without knowing entry semantics. */
const conditionsCover = (r1: OverlapRule, r2: OverlapRule): boolean => {
  const c1 = conditionSet(r1.conditions);
  const c2 = conditionSet(r2.conditions);
  return [...c1].every((e) => c2.has(e));
};

const identitiesCover = (r1: OverlapRule, r2: OverlapRule): boolean => {
  if (r1.identities.length === 0) return true;
  if (r2.identities.length === 0) return false;
  const set1 = new Set(r1.identities.map((i) => `${i.type}:${i.id}`));
  return r2.identities.every((i) => set1.has(`${i.type}:${i.id}`));
};

/** A target that can match a request at all (see the evaluator). Every kind is
 * now live: an empty-tools app target matches the whole app (its provider's
 * catalog hosts), and a connection target resolves at connect to its
 * provider's whole app (empty only if the connection is gone — unknowable
 * statically, so treated as live). Kept as a switch so a future inert kind has
 * an obvious home. */
const isLive = (t: OverlapTarget): boolean => {
  switch (t.kind) {
    case "connection":
    case "app":
    case "secret":
    case "network":
      return true;
  }
};

/** Whether the rule drives credential injection at connect (step 8): an ALLOW
 * rule (inject-select collects allow rules only — a block never injects) with
 * a connection target, a secret target, or an app target with a
 * `connectionScope`. Such a rule keeps live effect even when its decision
 * surface is shadowed — see the truthfulness fence in the header. */
const hasInjectionEffect = (r: OverlapRule): boolean =>
  r.action === "allow" &&
  r.targets.some(
    (t) =>
      t.kind === "connection" ||
      t.kind === "secret" ||
      (t.kind === "app" && t.connectionScope !== null),
  );

/** Targets whose matching IGNORES the rule's conditions (host-only arms in
 * both engines): whole-app and secret. Connection is included CONSERVATIVELY
 * (a tool-narrowed connection actually honors conditions via the fan-out) —
 * inert because a connection rule is injection-bearing and never a shadow
 * victim, so this only ever suppresses a warn, never mis-warns. See the
 * conditions-asymmetry guard in the header. */
const ignoresConditions = (t: OverlapTarget): boolean =>
  (t.kind === "app" && t.tools.length === 0) ||
  t.kind === "secret" ||
  t.kind === "connection";

/** A network target that matches EVERY request — host "*", any path, any
 * method. The one coverer that soundly covers app/secret targets too. */
const isUniversal = (t: OverlapTarget): boolean =>
  t.kind === "network" &&
  t.hostPattern === "*" &&
  (t.pathPattern === null || t.pathPattern === "*") &&
  t.method === null;

const hostCover = (pattern1: string, pattern2: string): boolean => {
  if (pattern1 === "*") return true;
  // ASCII fold like the real matcher — JS toLowerCase folds the full Unicode
  // range (K→k), which would claim covers hostMatches doesn't deliver.
  if (asciiLower(pattern1) === asciiLower(pattern2)) return true;
  // A concrete (wildcard-free) later host is a one-element set — reuse the real
  // matcher. wildcard⊇wildcard is skipped (undecidable without edge risk).
  return !pattern2.includes("*") && hostMatches(pattern2, pattern1);
};

const GIT_PUSH_SUFFIX = "/git-receive-pack";

const networkCover = (
  t1: {
    hostPattern: string;
    pathPattern: string | null;
    method: string | null;
  },
  t2: {
    hostPattern: string;
    pathPattern: string | null;
    method: string | null;
  },
): boolean => {
  if (!hostCover(t1.hostPattern, t2.hostPattern)) return false;

  const p1 = t1.pathPattern;
  const p2 = t2.pathPattern;
  // A git-receive-pack pattern ALSO matches the GET info/refs push-discovery
  // request regardless of its own method (the endpoint-match bridge) — only an
  // any-path+any-method earlier target, or the identical path, soundly covers.
  if (p2 !== null && p2.endsWith(GIT_PUSH_SUFFIX)) {
    const universalPath = (p1 === null || p1 === "*") && t1.method === null;
    const samePath =
      p1 === p2 && (t1.method === null || methodEq(t1.method, t2.method));
    return universalPath || samePath;
  }

  const pathOk =
    p1 === null ||
    p1 === "*" ||
    (p2 !== null &&
      (p1 === p2 ||
        // Concrete later path = a one-element set — reuse the real matcher.
        (!p2.includes("*") &&
          !p1.endsWith(GIT_PUSH_SUFFIX) &&
          pathMatches(p2, p1))));
  if (!pathOk) return false;

  return t1.method === null || methodEq(t1.method, t2.method);
};

const methodEq = (m1: string, m2: string | null): boolean =>
  m2 !== null && asciiLower(m1) === asciiLower(m2);

/** Can earlier target t1 provably match every request the later target t2
 * matches? Sound comparisons only — anything else returns false. */
const targetCover = (t1: OverlapTarget, t2: OverlapTarget): boolean => {
  if (isUniversal(t1)) return true;
  if (t1.kind === "network" && t2.kind === "network") {
    return networkCover(t1, t2);
  }
  if (t1.kind === "app" && t2.kind === "app") {
    // Same provider; a WHOLE-app t1 (no tools = host-only on every catalog
    // host of the provider) covers ANY same-provider t2 — each tool's host is
    // in that set, and a whole-app t2 is the identical surface. A tools-named
    // t1 covers only a tools-subset t2 (never a whole-app one — it is
    // narrower). `connectionScope` never affects matching (injection-only), so
    // it plays no part in coverage.
    return (
      t1.provider === t2.provider &&
      (t1.tools.length === 0 ||
        (t2.tools.length > 0 &&
          t2.tools.every((tool) => t1.tools.includes(tool))))
    );
  }
  // Cross-kind, secret hosts, connection targets (provider unknowable
  // statically): undecidable → no.
  return false;
};

/** Does the earlier rule r1 provably match every request the later r2 matches
 * (r2 unreachable)? Requires identity + conditions + every live target cover. */
const ruleCovers = (r1: OverlapRule, r2: OverlapRule): boolean => {
  if (!identitiesCover(r1, r2)) return false;
  if (!conditionsCover(r1, r2)) return false;
  const liveTargets = r2.targets.filter(isLive);
  // A rule with no live targets matches nothing — different phenomenon, no warn.
  if (liveTargets.length === 0) return false;
  // CONDITIONS ASYMMETRY: a whole-app/secret victim target matches with r2's
  // conditions IGNORED, but a conditioned r1's network/tools targets match
  // only their conditioned slice — the subset test above is not enough there.
  // Such victims are provably covered only by an UNCONDITIONED coverer.
  if (
    liveTargets.some(ignoresConditions) &&
    conditionSet(r1.conditions).size > 0
  ) {
    return false;
  }
  const coverers = r1.targets.filter(isLive);
  return liveTargets.every((t2) => coverers.some((t1) => targetCover(t1, t2)));
};

// ── The analysis ────────────────────────────────────────────────────────────

/**
 * Analyze ONE level's rules (the editable table's scope) for provably-dead
 * rules. Input order is irrelevant — rules are re-sorted by priority exactly
 * like the evaluator's first-match walk. Disabled rules and the Default Rule
 * are excluded on both sides. At most one warning per rule, most specific
 * first: conflict > duplicate > shadowed.
 */
export const findPolicyOverlaps = (
  rules: readonly OverlapRule[],
): OverlapWarning[] => {
  const ordered = rules
    .filter((r) => r.enabled && !r.isDefault)
    .slice()
    .sort((a, b) => a.priority - b.priority);

  const warnings: OverlapWarning[] = [];
  const warned = new Set<string>();

  // Duplicates/conflicts: identical match signature — the first occurrence
  // wins first-match; every later twin is dead.
  const firstBySig = new Map<string, OverlapRule>();
  for (const r of ordered) {
    const sig = matchSig(r);
    const head = firstBySig.get(sig);
    if (!head) {
      firstBySig.set(sig, r);
      continue;
    }
    const kind = verdictSig(head) === verdictSig(r) ? "duplicate" : "conflict";
    // An OPPOSITE-action conflict on an injection-bearing ALLOW twin is fenced:
    // the block head contributes no injection while the allow twin keeps
    // injecting (position-independent union), so "its verdict never applies"
    // would invite deleting live injection. Duplicates and same-action
    // (modifier-only) conflicts contribute identically — those warns stand.
    if (
      kind === "conflict" &&
      head.action !== r.action &&
      hasInjectionEffect(r)
    ) {
      continue;
    }
    warnings.push({
      logicalId: r.logicalId,
      kind,
      byLogicalId: head.logicalId,
      byName: head.name,
    });
    warned.add(r.logicalId);
  }

  // Shadows: an earlier rule provably matches everything a later one matches.
  // Injection-bearing rules are exempt VICTIMS (never coverers-exempt): their
  // decision surface may be covered, but they still inject at connect — the
  // truthfulness fence in the header.
  for (let i = 1; i < ordered.length; i++) {
    const r2 = ordered[i];
    if (!r2 || warned.has(r2.logicalId) || hasInjectionEffect(r2)) continue;
    for (let j = 0; j < i; j++) {
      const r1 = ordered[j];
      if (!r1) continue;
      if (ruleCovers(r1, r2)) {
        warnings.push({
          logicalId: r2.logicalId,
          kind: "shadowed",
          byLogicalId: r1.logicalId,
          byName: r1.name,
        });
        warned.add(r2.logicalId);
        break;
      }
    }
  }

  return warnings;
};
