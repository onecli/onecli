import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * WHAT THE CHANNEL NARRATION SAYS, and when it says nothing.
 *
 * `pushTurnNarration` decides which of a batch's events becomes a task row.
 * Two rules carry real weight and are easy to break by accident:
 *
 *   - a batch that ENDS the turn must narrate nothing, because the clear
 *     path is already taking the card down and a row added now would
 *     describe work that has already finished;
 *   - an unknown tool must never have its own NAME echoed — MCP servers
 *     choose those, so the string is sandbox-controlled.
 *
 * Pinned against the real batch shapes observed on a live turn (2026-08-31):
 * text deltas and tool events arrive interleaved, and the terminal batch
 * carries the answer text together with `turn.done`.
 *
 * The tenancy fence that gates this call is pinned separately, in
 * `conversation.pg.test.ts` ("REPORTS the fence verdict").
 */

const narrateTurnActivity = vi.fn();
vi.mock("../services/channels/turn-receipt-service", () => ({
  narrateTurnActivity: (...args: unknown[]) => narrateTurnActivity(...args),
  clearTurnReceipts: vi.fn(),
  attachTurnReceipt: vi.fn(),
  moveTurnReceipt: vi.fn(),
  sweepStaleSessionReceipts: vi.fn(),
}));

import type { AgentEvent } from "@onecli/agent-protocol";

import { pushTurnNarration } from "./runner";

const push = (events: unknown[]) =>
  pushTurnNarration("turn-1", events as AgentEvent[]);

beforeEach(() => {
  narrateTurnActivity.mockReset();
});

describe("which event becomes the task row", () => {
  it("narrates the tool that started", () => {
    push([
      { type: "text.delta", text: "hi" },
      { type: "tool.started", callId: "c1", name: "bash" },
      { type: "tool.finished", callId: "c1" },
    ]);
    expect(narrateTurnActivity).toHaveBeenCalledWith(
      "turn-1",
      "Running a command",
    );
  });

  it("keeps only the LAST tool in a batch — earlier rows are already stale", () => {
    push([
      { type: "tool.started", callId: "c1", name: "bash" },
      { type: "tool.started", callId: "c2", name: "read" },
    ]);
    expect(narrateTurnActivity).toHaveBeenCalledTimes(1);
    expect(narrateTurnActivity).toHaveBeenCalledWith(
      "turn-1",
      "Reading a file",
    );
  });

  it("says nothing for a batch with no tool at all", () => {
    push([
      { type: "text.delta", text: "thinking out loud" },
      { type: "thinking.delta", text: "reasoning" },
    ]);
    expect(narrateTurnActivity).not.toHaveBeenCalled();
  });

  it("never echoes an unknown tool's own name — MCP servers choose those", () => {
    push([
      {
        type: "tool.started",
        callId: "c1",
        name: "mcp__evil__<script>alert(1)</script>",
      },
    ]);
    expect(narrateTurnActivity).toHaveBeenCalledWith("turn-1", "Using a tool");
  });
});

describe("when the narration must stay silent", () => {
  it("says NOTHING when the batch ends the turn", () => {
    push([
      { type: "text.delta", text: "done" },
      { type: "text", text: "the answer" },
      { type: "turn.done" },
    ]);
    expect(narrateTurnActivity).not.toHaveBeenCalled();
  });

  it("says NOTHING when a tool starts in the same batch that ends the turn", () => {
    // MUTATION-PROOF: remove the terminal early-return and this fails. A
    // tool that started in the batch that ends the turn has necessarily
    // finished, so narrating it would leave a row describing done work.
    push([
      { type: "tool.started", callId: "c1", name: "bash" },
      { type: "turn.done" },
    ]);
    expect(narrateTurnActivity).not.toHaveBeenCalled();
  });

  it("says NOTHING when the batch errored", () => {
    push([
      { type: "tool.started", callId: "c1", name: "bash" },
      { type: "error", message: "boom" },
    ]);
    expect(narrateTurnActivity).not.toHaveBeenCalled();
  });

  it("says NOTHING for an empty batch", () => {
    push([]);
    expect(narrateTurnActivity).not.toHaveBeenCalled();
  });
});
