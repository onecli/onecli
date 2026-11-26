// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

/**
 * One hook decides where an agent's runs are shown, so the kebab, a
 * schedule's History and a webhook's View runs
 * agree: the agent's own Activity section, narrowed by query.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws1/agents/ag1/schedules",
}));

const { useAgentActivityPaths } = await import("./use-agent-activity-paths");

describe("useAgentActivityPaths", () => {
  it("points at the agent's own Activity section", () => {
    const { result } = renderHook(() => useAgentActivityPaths());
    expect(result.current.activity("ag1")).toBe("/w/ws1/agents/ag1/activity");
    expect(result.current.runs("ag1", "cron")).toBe(
      "/w/ws1/agents/ag1/activity?view=cron",
    );
    expect(result.current.scheduleRuns("ag1", "cr1")).toBe(
      "/w/ws1/agents/ag1/activity?view=cron&schedule=cr1",
    );
    expect(result.current.webhookRuns("ag1", "wh1")).toBe(
      "/w/ws1/agents/ag1/activity?view=webhook&webhook=wh1",
    );
  });

  it("encodes ids", () => {
    const { result } = renderHook(() => useAgentActivityPaths());
    expect(result.current.scheduleRuns("ag1", "a&b")).toBe(
      "/w/ws1/agents/ag1/activity?view=cron&schedule=a%26b",
    );
  });
});
