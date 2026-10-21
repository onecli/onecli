/**
 * A tagged batch whose every request is itself a list of records, read as
 * ONE table, for every approval surface (the web card, the bell, Slack's
 * card and its CSV), so they always agree on when a batch is "one table"
 * and what that table holds.
 *
 * An agent that splits "fill the blanks on 9 accounts" by which fields each
 * record needs (6 x industry, 1 x employees, 2 x both) is still asking one
 * thing. Each request's title names its own count ("Update 6 Accounts",
 * "Update 1 Account"), so the action grouping would flag two of them as odd
 * ones out; here they read as the one change they are.
 *
 * CLIENT-SAFE: pure data, no Node builtins, no I/O.
 */
import { groupApprovals, type GroupableApproval } from "./approval-groups";
import { CHANGE_ORDER, cellOpOf, type CellOp } from "./record-change";

/** Most records and columns one merged table holds: the gateway's caps on
 *  one request's table (`summary::bulk::MAX_BULK_ROWS` / `MAX_BULK_FIELDS`),
 *  so a merged card is never bigger than a single request's can be. */
export const MAX_MERGED_ROWS = 200;
export const MAX_MERGED_FIELDS = 40;

/** The table shape these helpers read and build (the web's and the
 *  adapter's bulk types both fit). */
export interface BatchTableField {
  api: string;
  label: string;
}
export interface BatchTableRow {
  id: string;
  name?: string;
  url?: string;
  new: (string | null)[];
  old?: (string | null)[];
  ops?: CellOp[];
  op?: CellOp;
  context?: (string | null)[];
}
export interface BatchTable {
  objectLabel: string;
  kind?: "update" | "create" | "delete";
  fields: BatchTableField[];
  rows: BatchTableRow[];
  oldValuesRead?: boolean;
  hiddenFields?: string[];
  context?: BatchTableField[];
}

/** A request that may carry a record table. */
export interface TabledApproval extends GroupableApproval {
  summary?:
    | (NonNullable<GroupableApproval["summary"]> & {
        bulk?: BatchTable | null;
      })
    | null;
}

export interface MergedBatchTable<A> {
  /** Every request merged, in arrival order: what Approve all decides. */
  approvals: A[];
  /** The agent's label for the task, when it gave one. */
  label: string | null;
  /** The earliest deadline among the requests (ms epoch). */
  expiresAt: number | null;
  /** The one table: every record of every request. */
  bulk: BatchTable;
}

/** A row's riskiest op first, as the gateway orders one request's rows. */
const risk = (op: CellOp | undefined): number => {
  const i = CHANGE_ORDER.findIndex((o) => o === op);
  return i < 0 ? CHANGE_ORDER.length : i;
};

/**
 * The batch as one table, or null when it would not read honestly as one.
 *
 * Merged only when every request is itself a list (a bulk call: its title
 * names a count, not one record), so a batch of one-record writes ("Update
 * Contact Ada", …) keeps its rows, each decidable on its own. Beyond that:
 * one task (one group key), exactly the tagged batch here (none missing,
 * none past the count), every table of the same object and kind, no record
 * in two requests (one row would show one change where two are sent; it
 * also keeps creates apart, whose rows each request numbers from 1),
 * current values read on all or none (no half-claimed legend), and no
 * bigger than one request's table may be. A field one request doesn't set
 * is "untouched" on its records. Context columns stay only when every
 * request has the same ones.
 *
 * Pass only live requests, and only while none of the batch is decided: a
 * decided request makes the card about what is left, row by row.
 */
export const mergeBatchTables = <A extends TabledApproval>(
  live: readonly A[],
): MergedBatchTable<A> | null => {
  if (live.length < 2) return null;
  const [group] = groupApprovals(live);
  if (!group || group.approvals.length !== live.length) return null;
  if (group.total !== live.length) return null;
  const tables: BatchTable[] = [];
  for (const a of group.approvals) {
    const b = a.summary?.bulk;
    if (a.summary?.subject || !b || b.rows.length === 0) return null;
    tables.push(b);
  }
  const [first] = tables;
  if (!first) return null;
  const kind = first.kind ?? "update";
  const read = first.oldValuesRead === true;
  if (
    tables.some(
      (b) =>
        b.objectLabel !== first.objectLabel ||
        (b.kind ?? "update") !== kind ||
        (b.oldValuesRead === true) !== read,
    )
  ) {
    return null;
  }
  const ids = new Set<string>();
  const fields: BatchTableField[] = [];
  const known = new Set<string>();
  for (const b of tables) {
    for (const row of b.rows) {
      if (ids.has(row.id)) return null;
      ids.add(row.id);
    }
    for (const f of b.fields) {
      if (known.has(f.api)) continue;
      known.add(f.api);
      fields.push(f);
    }
  }
  if (ids.size > MAX_MERGED_ROWS || fields.length > MAX_MERGED_FIELDS) {
    return null;
  }

  const contextKey = (b: BatchTable) =>
    JSON.stringify((b.context ?? []).map((c) => c.api));
  const context =
    first.context?.length &&
    tables.every((b) => contextKey(b) === contextKey(first))
      ? first.context
      : undefined;
  const rows = tables.flatMap((b) => {
    const from = fields.map((f) => b.fields.findIndex((g) => g.api === f.api));
    const pick = (values: readonly (string | null)[] | undefined) =>
      from.map((i) => (i < 0 ? null : (values?.[i] ?? null)));
    return b.rows.map((row): BatchTableRow => {
      // A field this request doesn't set is untouched on its records,
      // never read as a fill of an empty value.
      const ops = from.map(
        (i): CellOp => (i < 0 ? "untouched" : cellOpOf(row, i)),
      );
      const op = row.op ?? CHANGE_ORDER.find((o) => ops.includes(o));
      return {
        id: row.id,
        ...(row.name !== undefined && { name: row.name }),
        ...(row.url !== undefined && { url: row.url }),
        new: pick(row.new),
        ...(row.old && { old: pick(row.old) }),
        ops,
        ...(op && { op }),
        ...(context && row.context && { context: row.context }),
      };
    });
  });
  // Stable: arrival order within a kind.
  rows.sort((x, y) => risk(x.op) - risk(y.op));
  const hidden = [...new Set(tables.flatMap((b) => b.hiddenFields ?? []))];
  return {
    approvals: group.approvals,
    label: group.label,
    expiresAt: group.expiresAt,
    bulk: {
      objectLabel: first.objectLabel,
      ...(first.kind && { kind: first.kind }),
      fields,
      rows,
      oldValuesRead: read,
      ...(hidden.length > 0 && { hiddenFields: hidden }),
      ...(context && { context }),
    },
  };
};
