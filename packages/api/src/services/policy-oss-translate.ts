/**
 * OSS cutover translation (step 9.5): the pure old→new mapping for an OSS
 * project's legacy policy state — custom rules, app-permission tool rows,
 * blocklist rows, equipment assignments, and the org-row `policyMode` — into
 * `BackfillRuleInput`s the shared `backfillPublishScope` materializes.
 *
 * This is deliberately the PROJECT-ONLY subset (OSS has no org scope, no
 * directory identities, no granular session policies). The full translation
 * library lives in the EE overlay and never ships; the two implementations are
 * kept decision-identical by parity tests that run only in the private repo.
 *
 * Ordering law (mirrors the EE comparator's project arm): agent-scoped rules
 * above all-agents rules — reproducing the legacy gateway's exact-signature
 * agent shadow — then strictness (block < approval < rate < allow), stable on
 * input order. The caller feeds rows `createdAt asc` so ties resolve the same
 * on every run.
 */
import { getApp } from "../apps/registry";
import type { BackfillRuleInput, BackfillTargetInput } from "./policy-service";

/** The raw project `policy_rules` row subset the OSS cutover reads. */
export interface OssOldRule {
  id: string;
  name: string;
  agentId: string | null;
  hostPattern: string;
  pathPattern: string | null;
  method: string | null;
  action: string;
  enabled: boolean;
  rateLimit: number | null;
  rateLimitWindow: string | null;
  metadata: unknown;
  conditions: unknown;
}

/** A selective agent's equipment (project-owned resources only — the caller
 * applies the project-scope fence, mirroring the EE derivation). */
export interface OssAgentEquipment {
  agentId: string;
  secretMode: string;
  secretIds: string[];
  connections: { appConnectionId: string; sessionPolicy: unknown }[];
}

const metadataOf = (row: OssOldRule): Record<string, unknown> | null =>
  row.metadata && typeof row.metadata === "object"
    ? (row.metadata as Record<string, unknown>)
    : null;

/** A host-wide blocklist row (`metadata.type = "blocklist"`) — bridge-owned
 * after the cutover (`source: "blocklist"`), like cloud's. */
export const isOssBlocklistRow = (row: OssOldRule): boolean =>
  metadataOf(row)?.type === "blocklist";

const collapsed = (
  action: "allow" | "block",
  requireApproval: boolean,
  rateLimit: number | null,
  rateLimitWindow: "minute" | "hour" | "day" | null,
) => ({ action, requireApproval, rateLimit, rateLimitWindow });

/**
 * Collapse an old action to the v2 binary + modifiers (block → block ·
 * manual_approval → allow+requireApproval · rate_limit → allow+rate ·
 * allow → allow). Returns null for a malformed rate row (limit ≤ 0 or an
 * unknown window) or an unknown action — the legacy gateway drops those in its
 * own loader, so the translation must too.
 */
export const collapseOssAction = (row: OssOldRule) => {
  switch (row.action) {
    case "block":
      return collapsed("block", false, null, null);
    case "manual_approval":
      return collapsed("allow", true, null, null);
    case "rate_limit": {
      if (row.rateLimit === null || row.rateLimit <= 0) return null;
      if (
        row.rateLimitWindow !== "minute" &&
        row.rateLimitWindow !== "hour" &&
        row.rateLimitWindow !== "day"
      ) {
        return null;
      }
      return collapsed("allow", false, row.rateLimit, row.rateLimitWindow);
    }
    case "allow":
      return collapsed("allow", false, null, null);
    default:
      return null;
  }
};

/** Strictness rank (block 0 < approval 1 < rate 2 < allow 3) — the local
 * mirror of the EE `strictnessRank`; drift is fenced by the private parity
 * tests. */
const strictness = (r: BackfillRuleInput): number => {
  if (r.action === "block") return 0;
  if (r.requireApproval) return 1;
  if (r.rateLimit !== null) return 2;
  return 3;
};

/** Project ordering: agent-scoped above all-agents (the legacy agent shadow),
 * then strictness; stable on input order. */
export const ossRuleOrderComparator = (
  a: BackfillRuleInput,
  b: BackfillRuleInput,
): number => {
  const ai = a.identities.length > 0 ? 0 : 1;
  const bi = b.identities.length > 0 ? 0 : 1;
  if (ai !== bi) return ai - bi;
  return strictness(a) - strictness(b);
};

/**
 * One legacy row → one v2 rule carrying its host/path/method VERBATIM as a
 * network target. Custom rows AND app-permission tool rows both take this
 * mapping with `source: "custom"` — app-permission rows are adopted as
 * user-owned rules at translation time (OSS has no pre-cutover bridge era, so
 * there is nothing to re-tag later), and the stored host/path/method is exactly
 * what the legacy gateway matched, making the translation decision-exact
 * without any catalog dependency. Blocklist rows keep `source: "blocklist"`
 * (bridge-owned). Returns null for rows the legacy gateway dropped.
 */
export const translateOssRow = (row: OssOldRule): BackfillRuleInput | null => {
  const action = collapseOssAction(row);
  if (!action) return null;
  return {
    priority: 0, // assigned by translateOssProjectRules
    isDefault: false,
    source: isOssBlocklistRow(row) ? "blocklist" : "custom",
    name: row.name,
    ...action,
    // Behavioral conditions are arrays by the legacy contract; anything else
    // is dropped — an object here would read as a granular session policy and
    // 422 every publish through the OSS validator lock.
    conditions: Array.isArray(row.conditions) ? row.conditions : null,
    identities: row.agentId ? [{ type: "agent", id: row.agentId }] : [],
    targets: [
      {
        kind: "network",
        hostPattern: row.hostPattern,
        pathPattern: row.pathPattern,
        method: row.method,
      },
    ],
    enabled: row.enabled,
  };
};

/**
 * An app-permission TOOL row's provider, or null for anything else. Mirrors
 * the EE translator's `appToolMeta` law: `metadata.source = "app_permission"`
 * with STRING `provider` + `toolId` — blocklist rows carry `source` but no
 * `toolId`, so they never match (callers still check `isOssBlocklistRow`
 * first, matching `translateOssRow`'s own precedence).
 */
export const ossAppToolProvider = (row: OssOldRule): string | null => {
  const md = metadataOf(row);
  if (!md || md.source !== "app_permission") return null;
  if (typeof md.toolId !== "string" || typeof md.provider !== "string") {
    return null;
  }
  return md.provider;
};

type OssCollapsedAction = NonNullable<ReturnType<typeof collapseOssAction>>;

interface OssToolGroup {
  provider: string;
  collapsed: OssCollapsedAction;
  rows: OssOldRule[];
}

/**
 * The grouped app rule's display name — ONE definition shared by the OSS
 * cutover grouping and the EE compaction pass (a parity pair: the same merge
 * must yield the same name in both editions), action-suffixed so two groups of
 * one provider (an allow run and a block run) stay tellable apart.
 */
export const mergedAppRuleName = (
  provider: string,
  action: "allow" | "block",
  requireApproval: boolean,
): string => {
  const suffix =
    action === "block" ? " (blocked)" : requireApproval ? " (approval)" : "";
  return `${getApp(provider)?.name ?? provider}${suffix}`;
};

/** One ≥2-member tool-row group → its single grouped rule: named for the app,
 * carrying every member's stored endpoint VERBATIM as its own network target
 * (targets OR within a rule, so the union is decision-exact — no catalog
 * dependency), deduped on the exact (host, path, method) triple. The caller
 * guarantees the key fields (agent, action, approval, conditions) are uniform;
 * the first member is the representative. */
const groupedOssRule = (group: OssToolGroup): BackfillRuleInput => {
  const first = group.rows[0];
  const seen = new Set<string>();
  const targets: BackfillTargetInput[] = [];
  for (const row of group.rows) {
    const key = JSON.stringify([row.hostPattern, row.pathPattern, row.method]);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      kind: "network",
      hostPattern: row.hostPattern,
      pathPattern: row.pathPattern,
      method: row.method,
    });
  }
  return {
    priority: 0, // assigned by translateOssProjectRules
    isDefault: false,
    source: "custom",
    name: mergedAppRuleName(
      group.provider,
      group.collapsed.action,
      group.collapsed.requireApproval,
    ),
    ...group.collapsed,
    conditions:
      first && Array.isArray(first.conditions) ? first.conditions : null,
    identities: first?.agentId ? [{ type: "agent", id: first.agentId }] : [],
    targets,
    enabled: true,
  };
};

/**
 * The ordered policy set of one project's legacy rows (customs +
 * app-permission-derived + enabled blocklist), priorities `0..n-1`.
 *
 * App-permission TOOL rows are GROUPED (step 9.9): the enabled, non-rate rows
 * of one (agent, provider, action, approval, conditions) signature collapse
 * into a single rule via `groupedOssRule`, slotted at the FIRST member's
 * position — decision-identical, because the comparator's strictness bands are
 * contiguous and every rule within a band carries the same outcome. Rate tool
 * rows stay per-row (each legacy row had its own rate counter; pooling them
 * into one rule would share a single bucket), as do disabled tool rows (see
 * below) and singleton groups (a lone grant keeps its own name — byte-identical
 * to the ungrouped translation).
 *
 * Disabled custom/app-permission rows are CARRIED with `enabled: false`
 * (decision-neutral — the gateway loads `enabled = true` only — but the user's
 * data survives into the editor). Disabled blocklist rows are NOT derived: the
 * old row stays the blocklist panel's source of truth, exactly like the
 * bridge's re-derivation.
 */
export const translateOssProjectRules = (
  rows: OssOldRule[],
): BackfillRuleInput[] => {
  const eligible = rows.filter((r) => r.enabled || !isOssBlocklistRow(r));

  // Partition: blocklist first (translateOssRow's own precedence), collapse
  // BEFORE grouping (a malformed row is dropped exactly as today and must
  // never poison a group key).
  const toolGroups = new Map<string, OssToolGroup>();
  const groupKeyOfRow = new Map<OssOldRule, string>();
  for (const row of eligible) {
    if (isOssBlocklistRow(row) || !row.enabled) continue;
    const provider = ossAppToolProvider(row);
    if (provider === null) continue;
    const collapsedAction = collapseOssAction(row);
    if (!collapsedAction || collapsedAction.rateLimit !== null) continue;
    const key = stableJson([
      row.agentId,
      provider,
      collapsedAction.action,
      collapsedAction.requireApproval,
      Array.isArray(row.conditions) ? row.conditions : null,
    ]);
    groupKeyOfRow.set(row, key);
    const group = toolGroups.get(key);
    if (group) group.rows.push(row);
    else
      toolGroups.set(key, {
        provider,
        collapsed: collapsedAction,
        rows: [row],
      });
  }

  const emitted = new Set<string>();
  const translated: BackfillRuleInput[] = [];
  for (const row of eligible) {
    const key = groupKeyOfRow.get(row);
    const group = key === undefined ? undefined : toolGroups.get(key);
    if (key === undefined || !group || group.rows.length < 2) {
      const rule = translateOssRow(row);
      if (rule) translated.push(rule);
      continue;
    }
    if (emitted.has(key)) continue; // absorbed into the group's first slot
    emitted.add(key);
    translated.push(groupedOssRule(group));
  }

  const ordered = [...translated].sort(ossRuleOrderComparator);
  ordered.forEach((r, i) => {
    r.priority = i;
  });
  return ordered;
};

/** The ENABLED blocklist rows alone, unordered — the bridge's re-derivation
 * input (it interleaves them against the kept customs itself). */
export const translateOssBlocklistRows = (
  rows: OssOldRule[],
): BackfillRuleInput[] =>
  rows
    .filter((r) => r.enabled && isOssBlocklistRow(r))
    .map(translateOssRow)
    .filter((r): r is BackfillRuleInput => r !== null);

/**
 * The per-project Default Rule, seeded from the org-row `policyMode`
 * (`allow → Allow`, `deny → Block`) — the 9.5 de-hack of the instance-wide
 * mode masquerading as a project setting. Written for EVERY project (even
 * rule-less ones): its presence in the published generation is the gateway's
 * per-project cutover signal, and the deny carve (Default-Block bites only
 * credentialed non-LLM requests) is engine-side.
 */
/** Stamped on every migrated/seeded Default Rule so the cutover can tell its
 * own generations from a user publish that pre-empted migration (the default
 * row's description is not editable from the console, so the marker is
 * stable). */
export const OSS_MIGRATED_DEFAULT_DESCRIPTION =
  "Migrated from the legacy rules model";

export const ossProjectDefaultRule = (
  policyMode: string,
): BackfillRuleInput => ({
  priority: 0, // assigned by the caller (last)
  isDefault: true,
  source: "default",
  name: "Default Rule",
  description: OSS_MIGRATED_DEFAULT_DESCRIPTION,
  action: policyMode === "deny" ? "block" : "allow",
  rateLimit: null,
  rateLimitWindow: null,
  requireApproval: false,
  conditions: null,
  identities: [],
  targets: [],
});

/** An equipment translation result: the rules plus every dropped
 * `sessionPolicy` (OSS's gateway never enforced them — granular scoping is a
 * OneCLI Cloud capability — so they are dropped, loudly, by the caller). */
export interface OssEquipmentTranslation {
  rules: BackfillRuleInput[];
  droppedSessionPolicies: { agentId: string; appConnectionId: string }[];
}

const equipmentRule = (
  agentId: string,
  target: BackfillTargetInput,
): BackfillRuleInput => ({
  // Priority is assigned by the caller — equipment order is irrelevant to
  // injection, which unions all matching allow-targets.
  priority: 0,
  isDefault: false,
  source: "equipment",
  name: "Equipment access",
  action: "allow",
  rateLimit: null,
  rateLimitWindow: null,
  requireApproval: false,
  conditions: null,
  identities: [{ type: "agent", id: agentId }],
  targets: [target],
});

/**
 * A SELECTIVE agent's equipment → one `allow` rule per assigned secret and
 * connection (`source: "equipment"`, injection-only — the engine's assembler
 * drops them from the decision walk). ALL-mode agents impose no restriction →
 * no rules (`secretMode` stays the live switch until step 10). Stored
 * `sessionPolicy` values are dropped and reported.
 */
export const translateOssEquipment = (
  agents: OssAgentEquipment[],
): OssEquipmentTranslation => {
  const rules: BackfillRuleInput[] = [];
  const droppedSessionPolicies: OssEquipmentTranslation["droppedSessionPolicies"] =
    [];
  for (const agent of agents) {
    if (agent.secretMode !== "selective") continue;
    for (const secretId of agent.secretIds) {
      rules.push(equipmentRule(agent.agentId, { kind: "secret", secretId }));
    }
    for (const c of agent.connections) {
      if (
        c.sessionPolicy &&
        typeof c.sessionPolicy === "object" &&
        Object.keys(c.sessionPolicy).length > 0
      ) {
        droppedSessionPolicies.push({
          agentId: agent.agentId,
          appConnectionId: c.appConnectionId,
        });
      }
      rules.push(
        equipmentRule(agent.agentId, {
          kind: "connection",
          connectionId: c.appConnectionId,
          tools: [],
        }),
      );
    }
  }
  return { rules, droppedSessionPolicies };
};

/** JSON with recursively-sorted object keys — Postgres `jsonb` normalizes key
 * order, so a byte compare of raw `JSON.stringify` would false-diverge. */
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const sortedJson = (values: unknown[]): string =>
  stableJson([...values.map(stableJson)].sort());

/**
 * Canonical form for the boot verify: the decision-bearing fields of one rule,
 * order-insensitive on identities/targets and key-order-insensitive on JSON
 * values. The verify compares `translate(old)` against the stored generation
 * re-read in the gateway's order; unique priorities make the index alignment
 * exact.
 */
export const ossCanonRule = (r: BackfillRuleInput): string =>
  stableJson({
    priority: r.priority,
    isDefault: r.isDefault,
    source: r.source,
    name: r.name,
    description: r.description ?? null,
    action: r.action,
    rateLimit: r.rateLimit,
    rateLimitWindow: r.rateLimitWindow,
    requireApproval: r.requireApproval,
    enabled: r.enabled ?? true,
    conditions: r.conditions ?? null,
    identities: sortedJson(r.identities),
    targets: sortedJson(r.targets),
  });
