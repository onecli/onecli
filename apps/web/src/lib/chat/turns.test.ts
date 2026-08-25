import { describe, expect, it } from "vitest";
import type { Turn } from "@/lib/api/types";
import {
  hasActiveTurn,
  hasUnsettledTurn,
  isJoinedTurn,
  isJoiningTurn,
  resendableKeylessTurn,
} from "./turns";

const turn = (status: Turn["status"], overrides: Partial<Turn> = {}): Turn => ({
  id: `t-${status}`,
  conversationId: "cv",
  status,
  source: "web",
  userId: "u1",
  message: "m",
  error: null,
  errorCode: null,
  usage: null,
  followUpOfTurnId: null,
  attachments: [],
  startedAt: null,
  finishedAt: null,
  createdAt: "2026-08-10T00:00:00.000Z",
  ...overrides,
});

describe("the poll predicate", () => {
  it("a lone JOINING follow-up keeps the poll alive after the active turn closed", () => {
    // The no-event failure gap: a joining row can fail (a park writes
    // Turn.error, nothing streams) after its target finished. A poll keyed
    // on ACTIVE alone stops at the close and the bubble reads "received"
    // forever — unsettled is the honest predicate.
    const turns = [turn("done"), turn("joining")];
    expect(hasActiveTurn(turns)).toBe(false);
    expect(hasUnsettledTurn(turns)).toBe(true);
  });

  it("settles once everything is terminal", () => {
    expect(
      hasUnsettledTurn([turn("done"), turn("joined"), turn("aborted")]),
    ).toBe(false);
  });

  it("joining is NOT active — the Stop button targets the running turn, never a follow-up", () => {
    expect(hasActiveTurn([turn("joining")])).toBe(false);
  });
});

describe("follow-up narrowing", () => {
  it("tells the two follow-up states apart", () => {
    expect(isJoiningTurn(turn("joining"))).toBe(true);
    expect(isJoiningTurn(turn("joined"))).toBe(false);
    expect(isJoinedTurn(turn("joined"))).toBe(true);
    expect(isJoinedTurn(turn("running"))).toBe(false);
  });
});

describe("the in-place key door's resend guard", () => {
  const keyless = (overrides: Partial<Turn> = {}) =>
    turn("failed", {
      errorCode: "no_model_key",
      message: "the ask",
      ...overrides,
    });

  it("re-sends the message the user just asked", () => {
    const turns = [turn("done", { id: "t0" }), keyless({ id: "t1" })];
    expect(resendableKeylessTurn(turns)?.message).toBe("the ask");
  });

  it("skips trailing platform rows — a cron report landing after the failed ask doesn't change what was just asked", () => {
    const turns = [
      keyless({ id: "t1" }),
      turn("done", { id: "t2", userId: null, source: "cron" }),
    ];
    expect(resendableKeylessTurn(turns)?.id).toBe("t1");
  });

  it("never resurrects an older question — only the newest user turn qualifies", () => {
    const turns = [keyless({ id: "t1" }), turn("done", { id: "t2" })];
    expect(resendableKeylessTurn(turns)).toBeNull();
  });

  it("only fires for a keyless failure, not any failure", () => {
    expect(
      resendableKeylessTurn([
        turn("failed", { errorCode: "model_provider_error" }),
      ]),
    ).toBeNull();
    expect(resendableKeylessTurn([turn("failed")])).toBeNull();
  });

  it("never re-sends a platform-authored row (its message is a header, not the user's words)", () => {
    expect(
      resendableKeylessTurn([keyless({ userId: null, source: "cron" })]),
    ).toBeNull();
  });

  it("refuses when the failed turn carried files — bound attachments can never ride a second send", () => {
    const withFile = keyless({
      attachments: [
        {
          id: "att-1",
          name: "spec.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
          status: "bound",
        },
      ],
    });
    expect(resendableKeylessTurn([withFile])).toBeNull();
  });

  it("waits its turn — nothing re-sends while a run is active", () => {
    const turns = [turn("running", { id: "t0" }), keyless({ id: "t1" })];
    expect(resendableKeylessTurn(turns)).toBeNull();
  });

  it("an empty thread has nothing to re-send", () => {
    expect(resendableKeylessTurn([])).toBeNull();
  });
});
