import { describe, expect, it } from "vitest";
import { cronsFragment, cronsTools } from "./crons";

/**
 * Content pins for the scheduled-tasks capability. This text is the ONLY
 * thing that makes the model ever emit a one-shot schedule (the control
 * plane accepts the ISO form regardless) — drop a leg and "remind me in 20
 * minutes" quietly regresses to a sleep-loop poller.
 */

const scheduleTask = cronsTools.find((tool) => tool.name === "schedule_task");

describe("the scheduled-tasks teaching", () => {
  it("teaches both forms: recurring cron and one-shot ISO datetime", () => {
    const flat = cronsFragment.body.replace(/\s+/g, " ");
    expect(flat).toContain("5-field cron expression");
    expect(flat).toContain("happen ONCE at a future time");
    expect(flat).toContain("ISO 8601 local datetime");
    expect(flat).toContain(
      "fires once at that time, delivers its report, and completes",
    );
  });

  it("steers one-time waits off foreground sleeping and clock polling", () => {
    const flat = cronsFragment.body.replace(/\s+/g, " ");
    expect(flat).toContain(
      "Prefer a one-shot schedule over sleeping in the foreground or polling the clock",
    );
  });

  it("the schedule_task tool description carries both forms", () => {
    expect(scheduleTask?.description).toContain("recurring");
    expect(scheduleTask?.description).toContain("one-shot");
    expect(scheduleTask?.description).toContain("runs once at that time");
  });

  it("the schedule argument documents both syntaxes", () => {
    const schedule = (
      scheduleTask?.inputSchema as {
        properties?: Record<string, { description?: string }>;
      }
    ).properties?.schedule;
    expect(schedule?.description).toContain("5-field cron expression");
    expect(schedule?.description).toContain("ISO 8601 local datetime");
    expect(schedule?.description).toContain("the schedule completes");
  });
});
