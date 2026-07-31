import { describe, expect, it } from "vitest";

import { LAST_SEEN_WINDOW_MS, agentLastSeen } from "./agent-activity";

const NOW = Date.parse("2026-07-29T12:00:00Z");
const at = (msAgo: number) => new Date(NOW - msAgo);

describe("agentLastSeen", () => {
  it("renders a relative last-seen with the exact time attached", () => {
    const seen = agentLastSeen(at(5 * 60 * 1000), at(9e9), NOW);
    expect(seen.label).toBe("Last seen 5m ago");
    expect(seen.exactAt?.getTime()).toBe(NOW - 5 * 60 * 1000);
  });

  it("lowercases the just-now arm so it reads mid-sentence", () => {
    expect(agentLastSeen(at(10 * 1000), at(9e9), NOW).label).toBe(
      "Last seen just now",
    );
  });

  it("is fresh only within the last hour", () => {
    expect(agentLastSeen(at(59 * 60 * 1000), at(9e9), NOW).fresh).toBe(true);
    expect(agentLastSeen(at(61 * 60 * 1000), at(9e9), NOW).fresh).toBe(false);
  });

  it("null + created inside the window = provably never used", () => {
    const res = agentLastSeen(null, at(LAST_SEEN_WINDOW_MS / 2), NOW);
    expect(res).toEqual({ label: "Never used", exactAt: null, fresh: false });
  });

  it("null + created before the window = quiet, not never (ambiguity is real)", () => {
    const res = agentLastSeen(null, at(LAST_SEEN_WINDOW_MS * 2), NOW);
    expect(res.label).toBe("No recent activity");
  });
});
