// Pure companion to `PUT /policy/rules/order`: the API takes the FULL ordered
// id list (every non-default draft rule exactly once — customs, derived, and
// hidden equipment rows), while the editor only ever lets the user rearrange
// the CUSTOM rules. This rebuilds the full permutation from a new custom
// relative order without moving anything else.

/** The minimal row shape the rebuild needs (satisfied by PolicyRuleDto). */
export interface ReorderableRule {
  id: string;
  source: string;
}

/**
 * Walk the complete draft list in its current priority order and fill each
 * custom rule's position from `newCustomOrder` in sequence — non-custom rows
 * keep their positions, so a reorder can only ever change the customs'
 * relative order. Throws when `newCustomOrder` is not exactly the draft's
 * custom id set: both arguments must come from the same list snapshot.
 */
export const buildReorderIds = (
  fullDraftRules: readonly ReorderableRule[],
  newCustomOrder: readonly string[],
): string[] => {
  const customIds = new Set(
    fullDraftRules.filter((r) => r.source === "custom").map((r) => r.id),
  );
  const namesEveryCustomOnce =
    newCustomOrder.length === customIds.size &&
    new Set(newCustomOrder).size === newCustomOrder.length &&
    newCustomOrder.every((id) => customIds.has(id));
  if (!namesEveryCustomOnce) {
    throw new Error(
      "newCustomOrder must name each custom draft rule exactly once",
    );
  }
  const queue = [...newCustomOrder];
  return fullDraftRules.map((r) =>
    r.source === "custom" ? (queue.shift() ?? r.id) : r.id,
  );
};
