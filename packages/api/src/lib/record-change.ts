/**
 * What a change does to one field of one record, as every approval surface
 * shows it (the web card's table, Slack's card and its CSV). The gateway
 * decides each cell's op (`summary::bulk::CellOp`); this module is the one
 * place the surfaces read it, count it and word it, so the web and Slack
 * can never disagree on what "Updates 3" means.
 *
 * Pure and dependency-free: safe for the browser bundle.
 */

/** The ops a cell can carry, as the gateway serializes them
 *  (`summary::bulk::CellOp`): the one list validators and types read. */
export const CELL_OPS = [
  "untouched",
  "same",
  "fill",
  "overwrite",
  "clear",
] as const;
export type CellOp = (typeof CELL_OPS)[number];
/** The ops a reviewer sees (an untouched cell is shown as such, never
 *  counted). */
export type ShownOp = Exclude<CellOp, "untouched">;

/** Riskiest first: how legends and counts list the kinds. */
export const CHANGE_ORDER = ["clear", "overwrite", "fill", "same"] as const;

/** Each kind in words: the legend's label, a cell's one-word mark, and the
 *  dot Slack shows beside it (the web uses the same colors, as CSS). */
export const CHANGE_WORDS: Record<
  ShownOp,
  { label: string; mark: string; dot: string }
> = {
  clear: { label: "Clears", mark: "cleared", dot: "🔴" },
  overwrite: { label: "Updates", mark: "updated", dot: "🔵" },
  fill: { label: "Fills", mark: "filled", dot: "🟢" },
  same: { label: "No change", mark: "no change", dot: "⚪" },
};

/** The row shape these helpers read (the web and adapter types both fit). */
export interface ChangeRow {
  new: readonly (string | null)[];
  ops?: readonly CellOp[];
  op?: CellOp;
}

/** The op of one cell: the gateway's, else "fill" for a set value (its
 *  current value wasn't read, so nothing is claimed about it). */
export const cellOpOf = (row: ChangeRow, i: number): CellOp =>
  row.ops?.[i] ?? (row.new[i] == null ? "untouched" : "fill");

/** How many rows of each kind, a row counting as its riskiest change. In
 *  `CHANGE_ORDER`, kinds with no row left out. */
export const changeCounts = (
  rows: readonly ChangeRow[],
): { op: ShownOp; n: number }[] => {
  const counts = new Map<CellOp, number>();
  for (const row of rows) {
    const op = row.op ?? cellOpOf(row, 0);
    counts.set(op, (counts.get(op) ?? 0) + 1);
  }
  return CHANGE_ORDER.filter((op) => counts.get(op)).map((op) => ({
    op,
    n: counts.get(op) ?? 0,
  }));
};

/** A value as a cell shows it: an empty one says so. */
export const shownValue = (v: string | null | undefined): string =>
  v === null || v === undefined || v === "" ? "empty" : v;

/** A field this update leaves alone, as its cell says it: never a blank
 *  cell, which reads as "set to empty" or as a value that failed to load. */
export const UNTOUCHED_TEXT = "no change";
/** The same, with the "no change" dot, where cells carry dots (Slack). */
export const UNTOUCHED_CELL = `${CHANGE_WORDS.same.dot} ${UNTOUCHED_TEXT}`;

/** "Contacts", "Opportunities", "Deposit batches", or the label itself for
 *  one. Same rule as the gateway's titles (`summary::salesforce::plural`). */
export const pluralLabel = (label: string, n: number): string => {
  if (n === 1) return label;
  if (/[^aeiou]y$/i.test(label)) return `${label.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(label)) return `${label}es`;
  return `${label}s`;
};

/** What a change does to its records, as a title's verb (the gateway's
 *  titles use the same words). */
export const BULK_VERBS = {
  update: "Update",
  create: "Create",
  delete: "Delete",
} as const;

/** "Update 9 Accounts": a table of records as one title, worded as the
 *  gateway titles one request's table. */
export const bulkTitle = (bulk: {
  kind?: keyof typeof BULK_VERBS;
  objectLabel: string;
  rows: readonly unknown[];
}): string =>
  `${BULK_VERBS[bulk.kind ?? "update"]} ${bulk.rows.length} ${pluralLabel(bulk.objectLabel, bulk.rows.length)}`;
