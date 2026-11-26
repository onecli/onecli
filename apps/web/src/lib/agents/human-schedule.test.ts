import { describe, expect, it } from "vitest";
import { cronToHuman, humanToCron, humanToOnce } from "./human-schedule";

describe("humanToOnce", () => {
  const today = { year: 2026, month: 10, day: 29 };
  it.each([
    ["today at 9pm", "2026-10-29T21:00:00"],
    ["only once at 9pm today", "2026-10-29T21:00:00"],
    ["once at 14:30", "2026-10-29T14:30:00"],
    ["tomorrow at 8am", "2026-10-30T08:00:00"],
  ])("%s → %s", (text, once) => {
    expect(humanToOnce(text, today)).toBe(once);
  });

  it("rolls tomorrow over the month end", () => {
    expect(
      humanToOnce("tomorrow at 9", { year: 2026, month: 10, day: 31 }),
    ).toBe("2026-11-01T09:00:00");
  });

  it.each(["every day at 9", "at 9", "today at 25:00", "once"])(
    "is not a one-time phrase: %j",
    (text) => {
      expect(humanToOnce(text, today)).toBeNull();
    },
  );
});

describe("humanToCron", () => {
  it.each([
    ["every minute", "* * * * *"],
    ["every 5 minutes", "*/5 * * * *"],
    ["Every 15 min", "*/15 * * * *"],
    ["every hour", "0 * * * *"],
    ["hourly", "0 * * * *"],
    ["every 2 hours", "0 */2 * * *"],
    ["every day at 9", "0 9 * * *"],
    ["daily at 14:30", "30 14 * * *"],
    ["every day at 2:30pm", "30 14 * * *"],
    ["every day at noon", "0 12 * * *"],
    ["weekdays at 9am", "0 9 * * 1-5"],
    ["every weekday at 9:15", "15 9 * * 1-5"],
    ["weekends at 10", "0 10 * * 0,6"],
    ["every monday at 9am", "0 9 * * 1"],
    ["mon, wed and fri at 18:00", "0 18 * * 1,3,5"],
    ["on tuesdays at 8", "0 8 * * 2"],
    ["every monday at 6pm and 9pm", "0 18,21 * * 1"],
    ["daily at 9, 13 and 17", "0 9,13,17 * * *"],
  ])("%s → %s", (text, cron) => {
    expect(humanToCron(text)).toBe(cron);
  });

  it.each([
    "",
    "sometimes",
    "every 0 minutes",
    "every 90 minutes",
    "every day at 25:00",
    "every funday at 9",
    "at 13pm",
    "every day at 9:00 and 9:30",
  ])("does not guess: %j", (text) => {
    expect(humanToCron(text)).toBeNull();
  });
});

describe("cronToHuman", () => {
  it.each([
    ["* * * * *", "Every minute"],
    ["*/5 * * * *", "Every 5 minutes"],
    ["0 * * * *", "Every hour"],
    ["0 */2 * * *", "Every 2 hours"],
    ["0 9 * * *", "Every day at 09:00"],
    ["15 9 * * 1-5", "Weekdays at 09:15"],
    ["0 18 * * 1,3,5", "Every Mon, Wed, Fri at 18:00"],
    // Cron reads 7 as Sunday too, and the same day twice is one day.
    ["0 9 * * 7", "Every Sun at 09:00"],
    ["0 9 * * 0,7", "Every Sun at 09:00"],
    ["0 18,21 * * 1", "Every Mon at 18:00 and 21:00"],
    ["0 18,21 3 * *", "Every month on the 3rd at 18:00 and 21:00"],
  ])("%s → %s", (cron, text) => {
    expect(cronToHuman(cron)).toBe(text);
  });

  it("round-trips: what it says, the parser reads back the same", () => {
    for (const cron of [
      "*/5 * * * *",
      "0 9 * * *",
      "15 9 * * 1-5",
      "0 9,13,17 * * *",
    ]) {
      expect(humanToCron(cronToHuman(cron)!)).toBe(cron);
    }
  });

  it("names nothing it cannot say plainly", () => {
    expect(cronToHuman("0 9 1 1 *")).toBeNull();
    expect(cronToHuman("2026-08-25T14:00:00")).toBeNull();
  });
});
