import { describe, expect, it } from "vitest";
import { formatWhen, whenLabel } from "./schedule-grid";

describe("whenLabel", () => {
  it.each([
    ["0 9 * * *", "Every day at 09:00"],
    ["30 7 * * 1-5", "Weekdays at 07:30"],
    ["5 18 * * 1", "Every Mon at 18:05"],
    ["0 */6 * * *", "Every 6 hours"],
  ])("%s reads %j", (schedule, text) => {
    expect(whenLabel(schedule)).toBe(text);
  });

  it("reads a one-shot as its date, never the raw ISO string", () => {
    expect(whenLabel("2026-11-05T09:00:00")).toBe(
      `Once, ${formatWhen("2026-11-05T09:00:00")}`,
    );
  });

  it("names no shape it cannot say (the caller shows the expression)", () => {
    expect(whenLabel("7 3 1-15/3 * *")).toBeNull();
  });
});
