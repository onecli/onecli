import { describe, expect, it } from "vitest";
import type { EvalSchedule } from "@/lib/api";
import { formatTimestamp } from "@/lib/format-timestamp";
import { describeScheduleState, reportDestination } from "./eval-schedule";

describe("reportDestination", () => {
  it("names a channel, and says whose chat a chat report reaches", () => {
    expect(
      reportDestination(
        {
          to: "channel",
          channelRef: "C0QA",
          channelLabel: "#qa",
          when: "always",
        },
        false,
      ),
    ).toBe("#qa");
    expect(reportDestination({ to: "chat", when: "always" }, true)).toBe(
      "your chat",
    );
    // Results go to whoever last saved the schedule, never to the viewer.
    expect(reportDestination({ to: "chat", when: "always" }, false)).toBe(
      "a teammate's chat",
    );
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
    createdByViewer: true,
    report: null,
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
