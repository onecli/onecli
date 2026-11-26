import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalOutcome } from "../validations/approval-outcomes";

/**
 * The channel card's follow-up after an approval: it waits for what the
 * upstream did, and rewrites the card only when the approved request did NOT
 * do what was approved ("Create 9 Accounts" approved in
 * Slack, 0 created). A success leaves the click's own "Approved by" alone.
 */

const m = vi.hoisted(() => ({
  outcomes: vi.fn<() => Promise<ApprovalOutcome[]>>(),
  rewrite: vi.fn<
    (input: {
      lines: ReadonlyMap<string, string>;
      describes: "card" | "request";
      onlyPending: boolean;
    }) => Promise<void>
  >(async () => {}),
}));
vi.mock("./approval-outcome-service", () => ({
  listApprovalOutcomes: m.outcomes,
}));
vi.mock("./channels/gateway-approval-card", () => ({
  rewriteGatewayApprovalCards: m.rewrite,
}));
vi.mock("../lib/logger", () => ({
  logger: { child: () => ({ warn: vi.fn() }) },
}));

const { followApprovedResults } = await import("./approval-result-followup");

const INPUT = {
  workspaceId: "ws",
  organizationId: "org",
  agentId: "ada",
  decidedByName: "Alex Kim",
};

const approved = (
  approvalId: string,
  result?: ApprovalOutcome["result"],
): ApprovalOutcome => ({
  approvalId,
  outcome: "approved",
  decidedAt: "2026-01-05T09:00:00Z",
  ...(result && { result }),
});

const settle = async () => {
  await vi.advanceTimersByTimeAsync(2_000);
};

beforeEach(() => {
  vi.useFakeTimers();
  m.outcomes.mockReset();
  m.rewrite.mockClear();
});

describe("followApprovedResults", () => {
  it("rewrites the card when the approved request did nothing, naming why", async () => {
    m.outcomes.mockResolvedValue([
      approved("ap-1", {
        ok: false,
        succeeded: 0,
        total: 9,
        error: "BillingCountry: bad country",
        action: "Create 9 Accounts",
      }),
    ]);
    followApprovedResults({ ...INPUT, approvalIds: ["ap-1"] });
    await settle();

    expect(m.outcomes).toHaveBeenCalledWith({
      workspaceId: "ws",
      organizationId: "org",
      agentId: "ada",
      approvalIds: ["ap-1"],
    });
    const [call] = m.rewrite.mock.calls;
    // The line is about THIS request's result: a single card's line only.
    expect(call?.[0].describes).toBe("request");
    expect(call?.[0].onlyPending).toBe(false);
    expect([...(call?.[0].lines ?? [])]).toEqual([
      [
        "ap-1",
        "\u2705 Approved by Alex Kim \u00b7 \u26a0\ufe0f Created 0 of 9 \u00b7 BillingCountry: bad country",
      ],
    ]);
  });

  it("leaves a successful approval's card as the click wrote it", async () => {
    m.outcomes.mockResolvedValue([
      approved("ap-1", { ok: true, succeeded: 9, total: 9 }),
    ]);
    followApprovedResults({ ...INPUT, approvalIds: ["ap-1"] });
    await settle();
    expect(m.rewrite).not.toHaveBeenCalled();
  });

  it("waits for the result, then stops at its deadline without one", async () => {
    m.outcomes.mockResolvedValue([approved("ap-1")]);
    followApprovedResults({ ...INPUT, approvalIds: ["ap-1"] });
    await vi.advanceTimersByTimeAsync(40_000);
    const polls = m.outcomes.mock.calls.length;
    expect(polls).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(m.outcomes.mock.calls.length).toBe(polls);
    expect(m.rewrite).not.toHaveBeenCalled();
  });
});
