import { describe, expect, it } from "vitest";
import { isSlackConnected } from "./slack-presence";

/**
 * The connected-mark law: a presence row exists from the first attach click
 * (`pending_setup`), so existence is not connection. The predicate draws the
 * same line the Channels section draws for its attached face.
 */
describe("isSlackConnected", () => {
  it("a pending_setup presence is NOT connected — the mark must not lie", () => {
    expect(
      isSlackConnected([{ provider: "slack", status: "pending_setup" }]),
    ).toBe(false);
  });

  it("an active presence is connected", () => {
    expect(isSlackConnected([{ provider: "slack", status: "active" }])).toBe(
      true,
    );
  });

  it("needs_attention still counts — the section renders it as attached", () => {
    expect(
      isSlackConnected([{ provider: "slack", status: "needs_attention" }]),
    ).toBe(true);
  });

  it("a missing status (older API during deploy skew) reads as connected", () => {
    expect(isSlackConnected([{ provider: "slack" }])).toBe(true);
  });

  it("other providers never light the Slack mark", () => {
    expect(isSlackConnected([{ provider: "teams", status: "active" }])).toBe(
      false,
    );
  });

  it("no channels means no mark", () => {
    expect(isSlackConnected([])).toBe(false);
    expect(isSlackConnected(undefined)).toBe(false);
  });
});
