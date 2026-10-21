import { describe, expect, it } from "vitest";
import {
  MAX_MERGED_FIELDS,
  MAX_MERGED_ROWS,
  mergeBatchTables,
  type TabledApproval,
} from "./batch-table";

type Bulk = NonNullable<NonNullable<TabledApproval["summary"]>["bulk"]>;

const IND = { api: "Industry", label: "Industry" };
const EMP = { api: "NumberOfEmployees", label: "Number of employees" };

const acct = (i: number, values: (string | null)[]) => ({
  id: `001AA00000AbCd${String(i).padStart(4, "0")}`,
  name: `Account ${i}`,
  new: values,
  old: values.map(() => null),
  ops: values.map(() => "fill" as const),
  op: "fill" as const,
});

/** One bulk call (`PATCH /composite/sobjects`), as the gateway sends it:
 *  a title that counts its records, no per-record subject. */
const request = (
  id: string,
  fields: Bulk["fields"],
  rows: Bulk["rows"],
  over: Partial<Bulk> = {},
): TabledApproval => ({
  id,
  app: "salesforce",
  agent: { id: "ag1", name: "Bot" },
  summary: {
    action: `Update ${rows.length} Accounts`,
    bulk: {
      objectLabel: "Account",
      fields,
      rows,
      oldValuesRead: true,
      ...over,
    },
  },
  batch: { id: "b1", label: "Fill blank fields (9 accounts)", total: 3 },
  createdAt: "2026-10-14T13:06:18.000Z",
  expiresAt: "2026-10-14T13:09:18.000Z",
});

const fieldSplit = () => [
  request(
    "req-ind",
    [IND],
    [1, 2, 3, 4, 5, 6].map((i) => acct(i, ["Retail"])),
  ),
  request("req-emp", [EMP], [acct(7, ["1200"])]),
  request(
    "req-both",
    [IND, EMP],
    [acct(8, ["Banking", "40"]), acct(9, ["Insurance", "75"])],
  ),
];

describe("mergeBatchTables", () => {
  it("reads a batch split by field set as one table, untouched cells untouched", () => {
    const merged = mergeBatchTables(fieldSplit())!;
    expect(merged.approvals.map((a) => a.id)).toEqual([
      "req-ind",
      "req-emp",
      "req-both",
    ]);
    expect(merged.label).toBe("Fill blank fields (9 accounts)");
    expect(merged.bulk.fields.map((f) => f.api)).toEqual([IND.api, EMP.api]);
    expect(merged.bulk.rows).toHaveLength(9);
    const byName = new Map(merged.bulk.rows.map((r) => [r.name, r]));
    expect(byName.get("Account 1")).toMatchObject({
      new: ["Retail", null],
      ops: ["fill", "untouched"],
      op: "fill",
    });
    expect(byName.get("Account 7")).toMatchObject({
      new: [null, "1200"],
      ops: ["untouched", "fill"],
    });
    expect(byName.get("Account 8")).toMatchObject({
      new: ["Banking", "40"],
      ops: ["fill", "fill"],
    });
  });

  it("lists the riskiest rows first, across requests", () => {
    const [ind, emp, both] = fieldSplit();
    both!.summary!.bulk!.rows[1] = {
      ...acct(9, ["Insurance", "75"]),
      old: ["Retail", "70"],
      ops: ["overwrite", "overwrite"],
      op: "overwrite",
    };
    const merged = mergeBatchTables([ind!, emp!, both!])!;
    expect(merged.bulk.rows[0]?.name).toBe("Account 9");
  });

  it("keeps a batch of one-record writes as its rows", () => {
    // `PATCH /sobjects/Contact/{id}` carries a one-row table AND names its
    // record in the title (`subject`): each stays its own row, decided on
    // its own, never folded into a table with a CSV.
    const one = (id: string, i: number): TabledApproval => {
      const r = request(id, [IND], [acct(i, ["Retail"])]);
      r.summary!.action = `Update Account Account ${i}`;
      r.summary!.subject = { verb: "Update Account", record: `Account ${i}` };
      return r;
    };
    expect(
      mergeBatchTables([one("a", 1), one("b", 2), one("c", 3)]),
    ).toBeNull();
  });

  it("is null whenever one table would misread the batch", () => {
    const [ind, emp, both] = fieldSplit();
    const third = (over: Partial<Bulk>, rows = [acct(20, ["1"])]) =>
      mergeBatchTables([ind!, emp!, request("x", [EMP], rows, over)]);
    // A record in two requests: one row would hide the second change.
    expect(third({}, [acct(1, ["10"])])).toBeNull();
    // Another object, another kind, half-read current values.
    expect(third({ objectLabel: "Contact" })).toBeNull();
    expect(third({ kind: "delete" })).toBeNull();
    expect(third({ oldValuesRead: false })).toBeNull();
    // A request with no table.
    expect(
      mergeBatchTables([
        ind!,
        emp!,
        { ...both!, summary: { action: "Update" } },
      ]),
    ).toBeNull();
    // Not the whole tagged batch: still arriving, or one past the count.
    expect(mergeBatchTables([ind!, emp!])).toBeNull();
    expect(
      mergeBatchTables([
        ...fieldSplit(),
        request("y", [EMP], [acct(30, ["5"])]),
      ]),
    ).toBeNull();
    // Untagged: no claim it is one task.
    expect(
      mergeBatchTables(fieldSplit().map((a) => ({ ...a, batch: null }))),
    ).toBeNull();
    // Another agent's request never joins.
    expect(
      mergeBatchTables([
        ind!,
        emp!,
        { ...both!, agent: { id: "ag2", name: "Other" } },
      ]),
    ).toBeNull();
  });

  it("never merges creates: each request numbers its new records from 1", () => {
    // The gateway's create rows have no record id yet: `id` is the place
    // in the list, so two requests' row 1 can't be told apart.
    const create = (id: string, i: number) =>
      request(id, [IND], [{ ...acct(i, ["Retail"]), id: "1" }], {
        kind: "create",
      });
    expect(
      mergeBatchTables([create("a", 1), create("b", 2), create("c", 3)]),
    ).toBeNull();
  });

  it("is never bigger than one request's table may be", () => {
    const records = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => acct(from + i, ["Retail"]));
    const third = MAX_MERGED_ROWS - 2;
    const rows = (last: number) =>
      mergeBatchTables([
        request("a", [IND], records(0, 1)),
        request("b", [IND], records(1, 1)),
        request("c", [IND], records(2, last)),
      ]);
    expect(rows(third)?.bulk.rows).toHaveLength(MAX_MERGED_ROWS);
    expect(rows(third + 1)).toBeNull();

    // Each request under the column cap, together past it.
    const cols = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        api: `F${from + i}`,
        label: `F${from + i}`,
      }));
    const wide = (id: string, from: number, n: number, i: number) =>
      request(id, cols(from, n), [acct(i, Array(n).fill("x"))]);
    const half = MAX_MERGED_FIELDS / 2;
    expect(
      mergeBatchTables([
        wide("a", 0, half, 1),
        wide("b", half, half, 2),
        wide("c", 0, 1, 3),
      ]),
    ).not.toBeNull();
    expect(
      mergeBatchTables([
        wide("a", 0, half, 1),
        wide("b", half, half, 2),
        wide("c", MAX_MERGED_FIELDS, 1, 3),
      ]),
    ).toBeNull();
  });
});
