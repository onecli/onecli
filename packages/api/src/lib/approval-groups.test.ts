import { describe, expect, it } from "vitest";
import {
  approvalGroupKey,
  BATCH_SETTLE_MS,
  batchArrival,
  batchArrivalNote,
  groupApprovals,
  isOddOneOut,
  orderGroupRows,
  SUMMARY_MAX_CHANGES,
  summarizeChanges,
  recordNounOf,
  type GroupableApproval,
} from "./approval-groups";

let n = 0;
const ap = (over: Partial<GroupableApproval> = {}): GroupableApproval => {
  n += 1;
  return {
    id: `ap-${n}`,
    createdAt: new Date(Date.UTC(2026, 8, 30, 10, 0, n)).toISOString(),
    expiresAt: new Date(Date.UTC(2026, 8, 30, 10, 3, n)).toISOString(),
    method: "POST",
    host: "acme.my.salesforce.com",
    app: "salesforce",
    agent: { id: "ofer", name: "Ofer" },
    summary: { action: "Create Contact" },
    ...over,
  };
};

describe("groupApprovals", () => {
  it("groups a tagged task by batch id, even across actions", () => {
    const batch = { id: "t1", label: "Add 3 contacts", total: 3 };
    const groups = groupApprovals([
      ap({ batch }),
      ap({ batch }),
      ap({ batch, summary: { action: "Delete Contact" } }),
    ]);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.label).toBe("Add 3 contacts");
    expect(g.total).toBe(3);
    expect(g.mainAction).toBe("Create Contact");
    expect(g.otherActions).toEqual([{ action: "Delete Contact", count: 1 }]);
    expect(isOddOneOut(g, g.approvals[2]!)).toBe(true);
    expect(isOddOneOut(g, g.approvals[0]!)).toBe(false);
  });

  it("falls back to agent + app + action for untagged requests", () => {
    const groups = groupApprovals([
      ap(),
      ap(),
      ap({ summary: { action: "Update Contact" } }),
    ]);
    expect(groups.map((g) => g.approvals.length)).toEqual([2, 1]);
    expect(groups[0]!.label).toBeNull();
  });

  it("groups per-record titles by their verb: ten deletes are one card", () => {
    const del = (name: string, id: string) =>
      ap({
        summary: {
          action: `Delete Contact ${name}`,
          subject: { verb: "Delete Contact" },
        },
        id,
      });
    const groups = groupApprovals([
      del("Olivia Martinez", "d1"),
      del("Sarah Davis", "d2"),
      del("David Brown", "d3"),
      ap({
        summary: {
          action: "Update Contact Dana Reyes",
          subject: { verb: "Update Contact" },
        },
      }),
    ]);
    expect(groups.map((g) => g.approvals.length)).toEqual([3, 1]);
    expect(groups[0]!.mainAction).toBe("Delete Contact");
    expect(groups[1]!.mainAction).toBe("Update Contact");
  });

  it("never mixes agents or tasks", () => {
    const groups = groupApprovals([
      ap({ agent: { id: "a" } }),
      ap({ agent: { id: "b" } }),
      ap({ batch: { id: "t1" } }),
      ap({ batch: { id: "t2" } }),
    ]);
    expect(groups).toHaveLength(4);
    expect(
      approvalGroupKey(ap({ agent: { id: "a" }, batch: { id: "x" } })),
    ).not.toBe(
      approvalGroupKey(ap({ agent: { id: "b" }, batch: { id: "x" } })),
    );
  });

  it("a batch tag never pulls another app's request into the card", () => {
    // The tag is the agent's claim: reusing one id across Salesforce and
    // Gmail must still give two cards, so "Approve all" can't cover an
    // email the reviewer read as one more contact.
    const groups = groupApprovals([
      ap({ app: "salesforce", batch: { id: "t1" } }),
      ap({ app: "gmail", batch: { id: "t1" } }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("keeps arrival order and reports the earliest deadline", () => {
    const late = ap();
    const early = ap();
    early.createdAt = "2026-09-30T09:00:00.000Z";
    early.expiresAt = "2026-09-30T09:03:00.000Z";
    const [g] = groupApprovals([late, early]);
    expect(g!.approvals.map((a) => a.id)).toEqual([early.id, late.id]);
    expect(g!.expiresAt).toBe(Date.parse("2026-09-30T09:03:00.000Z"));
  });
});

describe("orderGroupRows", () => {
  const batch = { id: "t2", label: "Set Title", total: 4 };
  const update = (record: string) =>
    ap({
      batch,
      summary: {
        action: `Update Contact ${record}`,
        subject: { verb: "Update Contact", record },
      },
    });

  it("lists records by name in natural order, whatever order they arrived in", () => {
    const rows = ["Test10", "test02", "Test9", "Test1"].map(update);
    const [g] = groupApprovals(rows);
    expect(
      orderGroupRows(g!, g!.approvals).map((a) => a.summary?.subject?.record),
    ).toEqual(["Test1", "test02", "Test9", "Test10"]);
  });

  it("keeps an odd action first, so it can't hide among the sorted rows", () => {
    const rows = [update("B"), update("A")];
    const odd = ap({
      batch,
      summary: {
        action: "Delete Contact Z",
        subject: { verb: "Delete Contact", record: "Z" },
      },
    });
    const [g] = groupApprovals([...rows, odd]);
    expect(orderGroupRows(g!, g!.approvals).map((a) => a.id)).toEqual([
      odd.id,
      rows[1]!.id,
      rows[0]!.id,
    ]);
  });

  it("puts rows naming no record after named ones, in arrival order", () => {
    const first = ap({ batch });
    const second = ap({ batch });
    const named = update("Ada");
    const [g] = groupApprovals([second, first, named]);
    expect(orderGroupRows(g!, g!.approvals).map((a) => a.id)).toEqual([
      named.id,
      first.id,
      second.id,
    ]);
  });
});

describe("batchArrival", () => {
  const t0 = Date.UTC(2026, 8, 30, 10, 0, 0);
  const iso = (ms: number) => new Date(ms).toISOString();

  it("waits while fewer than the tagged total arrived and the batch is active", () => {
    const a = batchArrival(20, [iso(t0), iso(t0 + 300)], t0 + 1_000);
    expect(a).toEqual({
      arrived: 2,
      total: 20,
      arriving: true,
      missing: 0,
      settlesAt: t0 + 300 + BATCH_SETTLE_MS,
    });
  });

  it("is complete once the total arrived", () => {
    const at20 = Array.from({ length: 20 }, (_, i) => iso(t0 + i));
    expect(batchArrival(20, at20, t0 + 50).arriving).toBe(false);
  });

  it("stops waiting once the batch goes quiet, and says how many never came", () => {
    const at19 = Array.from({ length: 19 }, (_, i) => iso(t0 + i));
    const a = batchArrival(20, at19, t0 + 18 + BATCH_SETTLE_MS);
    expect(a).toMatchObject({ arriving: false, missing: 1, settlesAt: null });
  });

  it("never waits without a tagged total", () => {
    expect(batchArrival(null, [iso(t0)], t0).arriving).toBe(false);
    expect(batchArrival(0, [iso(t0)], t0).arriving).toBe(false);
  });
});

describe("batchArrivalNote", () => {
  const at = (ms: number) => new Date(ms).toISOString();
  // Well past the settle window of every arrival below (the window runs
  // from the NEWEST arrival).
  const quiet = BATCH_SETTLE_MS + 1_000;

  it("an agent blocked on this approval: the rest come after, never 'never arrived'", () => {
    // Tagged total 2, one call at a time: request 2 only leaves after
    // request 1 is decided.
    expect(batchArrivalNote(batchArrival(2, [at(0)], quiet))).toBe(
      "1 of 2 here. The other one may only be sent after you decide this one. Approve all covers the 1 shown.",
    );
  });

  it("counts the rest, and says 'these' for several shown", () => {
    expect(
      batchArrivalNote(batchArrival(5, [at(0), at(1), at(2)], quiet)),
    ).toBe(
      "3 of 5 here. The other 2 may only be sent after you decide these. Approve all covers the 3 shown.",
    );
  });

  it("while arriving it waits; when complete or untagged it says nothing", () => {
    expect(batchArrivalNote(batchArrival(3, [at(0)], 1))).toBe(
      "1 of 3 here, waiting for the rest…",
    );
    expect(batchArrivalNote(batchArrival(2, [at(0), at(1)], quiet))).toBeNull();
    expect(batchArrivalNote(batchArrival(null, [at(0)], quiet))).toBeNull();
  });
});

describe("summarizeChanges", () => {
  const update = (
    record: string,
    title: string,
    extra: [string, string][] = [],
  ) =>
    ap({
      summary: {
        action: `Update Contact ${record}`,
        subject: { verb: "Update Contact", record, row: 0 },
        details: [
          { label: "Contact", value: `${record} (003QO00000Abc)` },
          { label: "Title", value: title },
          ...extra.map(([label, value]) => ({ label, value })),
        ],
      },
    });

  it("reads twenty updates to one value as one change", () => {
    const rows = Array.from({ length: 20 }, (_, i) => update(`T${i}`, "After"));
    const lines = summarizeChanges(rows);
    expect(lines).toHaveLength(1);
    expect(lines![0]!.fields).toEqual([["Title", "After"]]);
    expect(lines![0]!.rows).toHaveLength(20);
  });

  it("reads a reassignment to three owners as three changes, in first-seen order", () => {
    const owner = (r: string, o: string) =>
      ap({
        summary: {
          action: `Update Contact ${r}`,
          subject: { verb: "Update Contact", record: r, row: 0 },
          details: [
            { label: "Contact", value: r },
            { label: "SDR Owner", value: o },
          ],
        },
      });
    const lines = summarizeChanges([
      owner("A", "Alex Kim"),
      owner("B", "Sam Lee"),
      owner("C", "Alex Kim"),
      owner("D", "Dana Cohen"),
    ]);
    expect(lines!.map((l) => [l.fields[0]![1], l.rows.length])).toEqual([
      ["Alex Kim", 2],
      ["Sam Lee", 1],
      ["Dana Cohen", 1],
    ]);
  });

  it("keeps a second field in the change, so different pairs never merge", () => {
    const lines = summarizeChanges([
      update("A", "After", [["Phone", "1"]]),
      update("B", "After", [["Phone", "2"]]),
    ]);
    expect(lines).toHaveLength(2);
  });

  it("refuses to summarize what it would hide", () => {
    // A row naming no record.
    expect(summarizeChanges([ap(), update("A", "After")])).toBeNull();
    // A row that changes nothing visible.
    const bare = ap({
      summary: {
        action: "Delete Contact A",
        subject: { verb: "Delete Contact", record: "A", row: 0 },
        details: [{ label: "Contact", value: "A" }],
      },
    });
    expect(summarizeChanges([bare])).toBeNull();
    // Too many distinct changes to read as one.
    const many = Array.from({ length: SUMMARY_MAX_CHANGES + 1 }, (_, i) =>
      update(`R${i}`, `V${i}`),
    );
    expect(summarizeChanges(many)).toBeNull();
  });

  it("never merges rows that differ past the fields a line names", () => {
    // Same Title and Phone, different Email: one line would hide the Email,
    // and Approve all would cover a change nobody saw.
    const rows = [
      update("A", "After", [
        ["Phone", "1"],
        ["Email", "a@example.com"],
      ]),
      update("B", "After", [
        ["Phone", "1"],
        ["Email", "b@example.com"],
      ]),
    ];
    expect(summarizeChanges(rows)).toBeNull();
  });
});

describe("recordNounOf", () => {
  it("is the verb's object, lower-case, else 'record'", () => {
    const of = (verb?: string) =>
      recordNounOf(
        ap({ summary: { action: "x", subject: verb ? { verb } : null } }),
      );
    expect(of("Update Contact")).toBe("contact");
    expect(of("Update Deposit Batch")).toBe("deposit batch");
    expect(of("Archive")).toBe("record");
    expect(of()).toBe("record");
    expect(recordNounOf(undefined)).toBe("record");
  });
});
