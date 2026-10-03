import { describe, expect, it } from "vitest";
import {
  approvalGroupKey,
  groupApprovals,
  isOddOneOut,
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
