import { describe, expect, it } from "vitest";
import type { EvalSchedule } from "@/lib/api";
import { formatTimestamp } from "@/lib/format-timestamp";
import {
  composeSchedule,
  describeSchedule,
  describeScheduleState,
  draftFromSchedule,
  type ScheduleDraft,
} from "./eval-schedule";

const draft = (patch: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
  preset: "daily",
  time: "09:00",
  custom: "",
  timezone: "UTC",
  ...patch,
});

describe("composeSchedule", () => {
  it.each([
    ["daily", "09:00", "0 9 * * *"],
    ["weekdays", "07:30", "30 7 * * 1-5"],
    ["weekly", "18:05", "5 18 * * 1"],
  ] as const)("%s at %s is %s", (preset, time, expected) => {
    expect(composeSchedule(draft({ preset, time }))).toBe(expected);
  });

  it.each(["9am", "24:00", "09:60", ""])("refuses the time %j", (time) => {
    expect(composeSchedule(draft({ time }))).toBeNull();
  });

  it("passes a custom expression through, trimmed", () => {
    expect(
      composeSchedule(draft({ preset: "custom", custom: " 0 */6 * * * " })),
    ).toBe("0 */6 * * *");
    expect(composeSchedule(draft({ preset: "custom", custom: " " }))).toBe(
      null,
    );
  });
});

describe("draftFromSchedule", () => {
  it("defaults to daily at 09:00 in the browser's zone", () => {
    expect(draftFromSchedule(null, "Asia/Jerusalem")).toMatchObject({
      preset: "daily",
      time: "09:00",
      timezone: "Asia/Jerusalem",
    });
  });

  it.each(["0 9 * * *", "30 7 * * 1-5", "5 18 * * 1"])(
    "round-trips the preset %s",
    (schedule) => {
      const restored = draftFromSchedule({ schedule, timezone: "UTC" }, "X");
      expect(restored.preset).not.toBe("custom");
      expect(composeSchedule(restored)).toBe(schedule);
    },
  );

  it("opens anything else as custom, as written", () => {
    expect(
      draftFromSchedule({ schedule: "0 */6 * * *", timezone: "UTC" }, "X"),
    ).toMatchObject({ preset: "custom", custom: "0 */6 * * *" });
  });
});

describe("describeSchedule", () => {
  it.each([
    ["0 9 * * *", "Daily at 09:00"],
    ["30 7 * * 1-5", "Weekdays at 07:30"],
    ["5 18 * * 1", "Mondays at 18:05"],
    ["0 */6 * * *", "Cron 0 */6 * * *"],
  ])("%s reads %j", (schedule, text) => {
    expect(describeSchedule(schedule)).toBe(text);
  });
});

describe("describeScheduleState", () => {
  const saved = (patch: Partial<EvalSchedule> = {}): EvalSchedule => ({
    schedule: "0 9 * * *",
    timezone: "UTC",
    enabled: true,
    disabledReason: null,
    nextFireAt: "2026-10-14T09:00:00.000Z",
    lastFiredAt: null,
    lastOutcome: null,
    ...patch,
  });

  it("says when it runs next, with no last outcome yet", () => {
    expect(describeScheduleState(saved())).toEqual({
      status: `Next run ${formatTimestamp("2026-10-14T09:00:00.000Z")}`,
      alert: false,
      last: null,
    });
  });

  it("alerts only when a person must act: the creator lost access", () => {
    expect(
      describeScheduleState(
        saved({ enabled: false, disabledReason: "authorization" }),
      ),
    ).toMatchObject({
      alert: true,
      status: expect.stringMatching(/Save it again/),
    });
    expect(
      describeScheduleState(
        saved({ enabled: false, disabledReason: "completed" }),
      ),
    ).toMatchObject({
      alert: false,
      status: expect.stringMatching(/^Finished/),
    });
    expect(describeScheduleState(saved({ enabled: false }))).toMatchObject({
      alert: false,
      status: "Paused",
    });
  });

  it("says what the last fire did, and when it fired", () => {
    expect(
      describeScheduleState(saved({ lastOutcome: "skipped_busy" })).last,
    ).toBe("Last scheduled run skipped: a run was already going");
    expect(
      describeScheduleState(
        saved({
          lastOutcome: "started",
          lastFiredAt: "2026-10-13T09:02:00.000Z",
        }),
      ).last,
    ).toBe(
      `Last scheduled run started ${formatTimestamp("2026-10-13T09:02:00.000Z")}`,
    );
  });
});
