// The staged-changes diff: draft vs published, over CUSTOM rules + the Default
// Rule's action only. Bridge-derived rows (blocklist/equipment — plus
// app_permission pre-adoption; the editing cutover re-tags those `custom` with
// draft↔published logicalId parity, making them first-class here) are
// system-managed — they re-materialize with fresh logicalIds and legitimately
// differ between draft and published — so they never count as "your changes".
// Keyed by `logicalId`, the generation-stable identity (row `id` regenerates on
// every publish). Pure + structural so the web editor can feed its DTOs
// directly and the logic stays unit-testable here.

/** The structural slice of a policy rule the diff reads — the web `PolicyRuleV2`
 * DTO satisfies it as-is. */
export interface DiffableRule {
  logicalId: string;
  source: string;
  isDefault: boolean;
  priority: number;
  name: string;
  description: string | null;
  action: "allow" | "block";
  enabled: boolean;
  requireApproval: boolean;
  rateLimit: number | null;
  rateLimitWindow: string | null;
  identities: { type: string; id: string }[];
  targets: unknown[];
  conditions: unknown;
}

export interface RuleChange {
  logicalId: string;
  name: string;
  action: "allow" | "block";
  /** For "changed" entries: compact human descriptions of what moved. */
  details: string[];
}

export interface PolicyDiff {
  added: RuleChange[];
  changed: RuleChange[];
  removed: RuleChange[];
  /** Same rules, same content — only the evaluation order moved. */
  reordered: boolean;
  defaultChange: { from: "allow" | "block"; to: "allow" | "block" } | null;
  /** Total user-visible changes (rules + a reorder + the default). */
  count: number;
  /** logicalId → chip state for the draft rows ("new" | "changed"). */
  rowState: Map<string, "new" | "changed">;
}

const customsOf = <T extends DiffableRule>(rules: T[]): T[] =>
  rules
    .filter((r) => r.source === "custom" && !r.isDefault)
    .slice()
    .sort((a, b) => a.priority - b.priority);

const rateLabel = (r: DiffableRule): string =>
  r.rateLimit !== null && r.rateLimitWindow !== null
    ? `${r.rateLimit}/${r.rateLimitWindow}`
    : "none";

const identitySig = (r: DiffableRule): string =>
  r.identities
    .map((i) => `${i.type}:${i.id}`)
    .sort()
    .join(",");

const targetSig = (r: DiffableRule): string =>
  r.targets
    .map((t) => JSON.stringify(t))
    .sort()
    .join(",");

const actionLabel = (a: "allow" | "block") =>
  a === "allow" ? "Allow" : "Block";

/** Compact, human field-level differences between two versions of one rule. */
const describeRuleChanges = (
  draft: DiffableRule,
  published: DiffableRule,
): string[] => {
  const details: string[] = [];
  if (draft.name !== published.name)
    details.push(`Renamed from “${published.name}”`);
  if ((draft.description ?? null) !== (published.description ?? null))
    details.push("Description edited");
  if (draft.action !== published.action)
    details.push(
      `Action: ${actionLabel(published.action)} → ${actionLabel(draft.action)}`,
    );
  if (draft.enabled !== published.enabled)
    details.push(draft.enabled ? "Enabled" : "Disabled");
  if (identitySig(draft) !== identitySig(published))
    details.push("Applies-to edited");
  if (targetSig(draft) !== targetSig(published)) details.push("Target edited");
  if (draft.requireApproval !== published.requireApproval)
    details.push(
      draft.requireApproval ? "Now requires approval" : "Approval removed",
    );
  if (rateLabel(draft) !== rateLabel(published))
    details.push(`Rate limit: ${rateLabel(published)} → ${rateLabel(draft)}`);
  if (JSON.stringify(draft.conditions) !== JSON.stringify(published.conditions))
    details.push("Conditions edited");
  return details;
};

export const diffPolicyChanges = (
  draftRules: DiffableRule[],
  publishedRules: DiffableRule[],
  draftDefault: { action: "allow" | "block" } | undefined,
  publishedDefault: { action: "allow" | "block" } | undefined,
): PolicyDiff => {
  const draft = customsOf(draftRules);
  const published = customsOf(publishedRules);
  const draftById = new Map(draft.map((r) => [r.logicalId, r]));
  const publishedById = new Map(published.map((r) => [r.logicalId, r]));

  const added: RuleChange[] = [];
  const changed: RuleChange[] = [];
  const removed: RuleChange[] = [];
  const rowState = new Map<string, "new" | "changed">();

  for (const r of draft) {
    const prev = publishedById.get(r.logicalId);
    if (!prev) {
      added.push({
        logicalId: r.logicalId,
        name: r.name,
        action: r.action,
        details: [],
      });
      rowState.set(r.logicalId, "new");
      continue;
    }
    const details = describeRuleChanges(r, prev);
    if (details.length > 0) {
      changed.push({
        logicalId: r.logicalId,
        name: r.name,
        action: r.action,
        details,
      });
      rowState.set(r.logicalId, "changed");
    }
  }
  for (const r of published) {
    if (!draftById.has(r.logicalId)) {
      removed.push({
        logicalId: r.logicalId,
        name: r.name,
        action: r.action,
        details: [],
      });
    }
  }

  // Reorder: the rules both sides share, compared by their relative order.
  const common = new Set(
    draft.map((r) => r.logicalId).filter((id) => publishedById.has(id)),
  );
  const draftOrder = draft
    .map((r) => r.logicalId)
    .filter((id) => common.has(id));
  const publishedOrder = published
    .map((r) => r.logicalId)
    .filter((id) => common.has(id));
  const reordered = draftOrder.join("|") !== publishedOrder.join("|");

  const defaultChange =
    draftDefault &&
    publishedDefault &&
    draftDefault.action !== publishedDefault.action
      ? { from: publishedDefault.action, to: draftDefault.action }
      : null;

  const count =
    added.length +
    changed.length +
    removed.length +
    (reordered ? 1 : 0) +
    (defaultChange ? 1 : 0);

  return { added, changed, removed, reordered, defaultChange, count, rowState };
};
