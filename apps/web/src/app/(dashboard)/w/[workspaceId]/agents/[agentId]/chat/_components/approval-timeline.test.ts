// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingApproval } from "@/lib/api/approvals";
import {
  approvalTimeline,
  GATHER_MS,
  useApprovalTimeline,
} from "./approval-timeline";
import type { ApprovalCard } from "./use-approval-cards";

let n = 0;
const cardOf = (
  over: Partial<PendingApproval> = {},
  settled?: ApprovalCard["settled"],
): ApprovalCard => {
  n += 1;
  const createdAt = new Date(Date.UTC(2026, 8, 30, 10, 0, n)).toISOString();
  return {
    at: Date.parse(createdAt),
    settled,
    approval: {
      id: `ap-${n}`,
      method: "POST",
      url: "https://x.test/",
      host: "x.test",
      path: "/",
      headers: {},
      app: "salesforce",
      agent: { id: "ofer", name: "Ofer" },
      summary: { action: "Create Contact", details: [] },
      createdAt,
      expiresAt: createdAt,
      ...over,
    },
  };
};

afterEach(() => vi.useRealTimers());

describe("approvalTimeline", () => {
  it("keeps a lone request as the single card", () => {
    expect(approvalTimeline([cardOf()]).map((e) => e.kind)).toEqual(["single"]);
  });

  it("folds a task's live requests into one grouped card, its decided ones kept on it", () => {
    const batch = { id: "t1" };
    const entries = approvalTimeline([
      cardOf({ batch }),
      cardOf({ batch }),
      cardOf({ batch }, "approved"),
    ]);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (entry?.kind !== "group") throw new Error("expected a group");
    expect(entry.group.approvals).toHaveLength(2);
    expect(entry.settled.map((s) => s.outcome)).toEqual(["approved"]);
  });

  it("leaves one Done record when every request has settled", () => {
    const batch = { id: "t1", label: "Add 3 contacts" };
    const [entry, ...rest] = approvalTimeline([
      cardOf({ batch }, "approved"),
      cardOf({ batch }, "approved"),
      cardOf({ batch }, "denied"),
    ]);
    expect(rest).toEqual([]);
    if (entry?.kind !== "done") throw new Error("expected done");
    // The gateway's action, never the agent's label.
    expect(entry.action).toBe("Create Contact");
    expect(entry.count).toBe(3);
    expect(entry.counts).toMatchObject({ approved: 2, denied: 1 });
  });

  it("never merges two agents", () => {
    const entries = approvalTimeline([
      cardOf({ agent: { id: "a", name: "A" } }),
      cardOf({ agent: { id: "b", name: "B" } }),
    ]);
    expect(entries.map((e) => e.kind)).toEqual(["single", "single"]);
  });

  it("never piles a re-run onto the decided card: the old run is Done, the new one its own card", () => {
    // Five Create Contacts, all decided; then "do it again" sends four more
    // with the same agent + action key (no batch header).
    const first = [1, 2, 3, 4, 5].map(() => cardOf({}, "denied"));
    const decidedAt = Math.max(...first.map((c) => c.at)) + 1_000;
    for (const c of first) c.settledAt = decidedAt;
    const again = [1, 2, 3, 4].map((i) => ({
      ...cardOf(),
      at: decidedAt + 5_000 + i,
    }));
    const entries = approvalTimeline([...first, ...again]);
    expect(entries.map((e) => e.kind)).toEqual(["done", "group"]);
    const [, live] = entries;
    if (live?.kind !== "group") throw new Error("expected a group");
    expect(live.group.approvals).toHaveLength(4);
    expect(live.settled).toEqual([]);
  });

  it("a task the agent announced as several is a group from its first request", () => {
    const entries = approvalTimeline([
      cardOf({ batch: { id: "t9", total: 3 } }),
    ]);
    expect(entries.map((e) => e.kind)).toEqual(["group"]);
  });
});

describe("useApprovalTimeline", () => {
  it("holds a NEW lone request briefly so a burst lands as one card, never a flashing single", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ cards }) => useApprovalTimeline(cards),
      { initialProps: { cards: [] as ApprovalCard[] } },
    );
    const a = cardOf();
    rerender({ cards: [a] });
    expect(result.current).toEqual([]);
    // Its sibling lands a beat later: shown at once, as a group.
    rerender({ cards: [a, cardOf()] });
    expect(result.current.map((e) => e.kind)).toEqual(["group"]);
  });

  it("shows a lone request after the hold, and never hides what was on screen at mount", () => {
    vi.useFakeTimers();
    const existing = cardOf();
    const { result, rerender } = renderHook(
      ({ cards }) => useApprovalTimeline(cards),
      { initialProps: { cards: [existing] } },
    );
    expect(result.current).toHaveLength(1);
    const lone = cardOf({ summary: { action: "Send email", details: [] } });
    rerender({ cards: [existing, lone] });
    expect(result.current).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(GATHER_MS + 10);
    });
    expect(result.current).toHaveLength(2);
  });
});
