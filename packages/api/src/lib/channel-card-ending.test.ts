import { describe, expect, it } from "vitest";
import {
  CHANNEL_CARD_DONE_LABEL,
  channelCardEndingOf,
  channelCardEndingText,
} from "./channel-card-ending";

/**
 * The words every channel card uses for an ending it did not see clicked.
 * One table for every provider: a Teams card reads the same as Slack's.
 */
describe("channel card endings", () => {
  it("reads only the endings it knows; anything else is no answer", () => {
    for (const known of ["approved", "denied", "cancelled", "replaced"]) {
      expect(channelCardEndingOf(known)).toBe(known);
    }
    for (const unknown of [undefined, "", "expired", "teleported", "decided"]) {
      expect(channelCardEndingOf(unknown)).toBeUndefined();
    }
  });

  it("places a decision on the dashboard only when the record does", () => {
    expect(channelCardEndingText("approved", "web")).toBe(
      "✅ Approved from the dashboard",
    );
    // A dashboard click the gateway alone recorded names no place.
    expect(channelCardEndingText("denied")).toBe(
      "⛔ Denied from the dashboard",
    );
    // Decided on another channel: never "from the dashboard".
    expect(channelCardEndingText("approved", "teams")).toBe("✅ Approved");
  });

  it("never says anyone decided what no one decided", () => {
    for (const ending of ["cancelled", "unknown", "replaced"] as const) {
      expect(channelCardEndingText(ending)).not.toMatch(/decided/i);
    }
    expect(channelCardEndingText("cancelled")).toBe(
      "Cancelled · the agent stopped waiting",
    );
    expect(channelCardEndingText("unknown")).toBe("No longer waiting");
    expect(CHANNEL_CARD_DONE_LABEL.unknown).toBe("no longer waiting");
  });

  it("uses no em dash in any copy a channel posts", () => {
    const copy = [
      ...Object.values(CHANNEL_CARD_DONE_LABEL),
      ...(
        ["approved", "denied", "cancelled", "replaced", "unknown"] as const
      ).flatMap((e) => [
        channelCardEndingText(e),
        channelCardEndingText(e, "x"),
      ]),
    ];
    for (const line of copy) expect(line).not.toContain("—");
  });
});
