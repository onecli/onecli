/**
 * Plain-language schedules ("every 5 minutes", "weekdays at 9:30", "today at
 * 9pm") to a schedule string, and cron back to words for display. These rules
 * cover the common phrasings instantly and for free; anything else returns
 * null and the dialog asks a fast model (crons/parse), whose answer it shows
 * in words before saving.
 *
 * Times are read in the schedule's timezone (the dialog's own field); this
 * module never touches clocks.
 */

const DAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const dayIndex = (word: string): number | null => {
  const hit = DAYS.findIndex((day) => day.startsWith(word) && word.length >= 3);
  return hit === -1 ? null : hit;
};

/** "9", "9am", "9:30", "14:05", "2:30pm", "noon", "midnight" → [h, m]. */
const parseTime = (raw: string): [number, number] | null => {
  const text = raw.trim();
  if (text === "noon") return [12, 0];
  if (text === "midnight") return [0, 0];
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3];
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59) return null;
  return [hour, minute];
};

/** "6pm and 9pm", "9, 13 and 17" → [hours, minute]. Cron can hold several
 * hours in one line only when they share a minute; mixed minutes → null. */
const parseTimes = (raw: string): [number[], number] | null => {
  const times = raw
    .split(/\s*(?:,|\band\b|&)\s*/)
    .filter(Boolean)
    .map(parseTime);
  if (times.length === 0 || times.some((t) => t === null)) return null;
  const parsed = times as [number, number][];
  const minute = parsed[0]![1];
  if (parsed.some(([, m]) => m !== minute)) return null;
  const hours = [...new Set(parsed.map(([h]) => h))].sort((a, b) => a - b);
  return [hours, minute];
};

/** "monday", "mon", "weekdays", "weekends", "mon, wed and fri" → cron dow. */
const parseDays = (raw: string): string | null => {
  const text = raw.trim();
  if (/^(weekdays?|work ?days?)$/.test(text)) return "1-5";
  if (/^weekends?$/.test(text)) return "0,6";
  const parts = text
    .split(/\s*(?:,|\band\b|&)\s*/)
    .map((part) => part.replace(/s$/, ""))
    .filter(Boolean);
  const indexes = parts.map(dayIndex);
  if (indexes.length === 0 || indexes.some((day) => day === null)) return null;
  return [...new Set(indexes as number[])].sort((a, b) => a - b).join(",");
};

const UNIT = String.raw`(min(?:ute)?s?|h(?:ou)?rs?|hours?)`;

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A one-time phrase ("today at 9pm", "tomorrow at 8am", "once at 9pm",
 * "only once at 9pm today") to the one-shot form "YYYY-MM-DDTHH:mm:00", or
 * null. `today` is the caller's local date (the module itself never reads a
 * clock); with no day, the time is today's.
 */
export const humanToOnce = (
  input: string,
  today: { year: number; month: number; day: number },
): string | null => {
  const text = input.toLowerCase().trim().replace(/\s+/g, " ");
  const once =
    /^(?:(?:only )?once )?(?:(today|tomorrow) )?at (.+?)(?: (today|tomorrow))?$/.exec(
      text,
    );
  // Without "once", "today" or "tomorrow" it is not a one-time phrase.
  if (!once || !/\b(once|today|tomorrow)\b/.test(text)) return null;
  const time = parseTime(once[2]!);
  if (!time) return null;
  const date = new Date(Date.UTC(today.year, today.month - 1, today.day));
  if ((once[1] ?? once[3]) === "tomorrow")
    date.setUTCDate(date.getUTCDate() + 1);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(time[0])}:${pad(time[1])}:00`;
};

/** Plain language to a cron expression, or null when not understood. */
export const humanToCron = (input: string): string | null => {
  const text = input
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!]$/, "");
  if (!text) return null;

  // every minute / every 5 minutes / every 2 hours
  const interval = new RegExp(`^every (?:(\\d+) )?${UNIT}$`).exec(text);
  if (interval) {
    const n = interval[1] ? Number(interval[1]) : 1;
    const minutes = interval[2]!.startsWith("m");
    if (minutes) {
      if (n < 1 || n > 59) return null;
      return n === 1 ? "* * * * *" : `*/${n} * * * *`;
    }
    if (n < 1 || n > 23) return null;
    return n === 1 ? "0 * * * *" : `0 */${n} * * *`;
  }
  if (/^(every hour|hourly)$/.test(text)) return "0 * * * *";

  // [every day | daily | every <days> | on <days> | <days>] [at <time>]
  const scheduled =
    /^(?:(?:every|each) )?(day|daily|.+?)?(?:,? at (.+))?$/.exec(
      text.replace(/^(?:every day|daily|each day)/, "day").replace(/^on /, ""),
    );
  if (!scheduled) return null;
  const daysPart = scheduled[1]?.trim();
  const timePart = scheduled[2];
  if (!timePart && (!daysPart || daysPart === "day")) return null;
  const time = parseTimes(timePart ?? "9");
  if (!time) return null;
  const dow =
    !daysPart || daysPart === "day" || daysPart === "daily"
      ? "*"
      : parseDays(daysPart);
  if (dow === null) return null;
  return `${time[1]} ${time[0].join(",")} * * ${dow}`;
};

/** 1 → "1st", 22 → "22nd", 13 → "13th". */
const ordinal = (raw: string): string => {
  const n = Number(raw);
  const suffix =
    n % 100 >= 11 && n % 100 <= 13
      ? "th"
      : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
};

/** ["a"] → "a", ["a", "b", "c"] → "a, b and c". */
const listWords = (items: string[]): string =>
  items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** A cron expression in words, or null for shapes this does not name. */
export const cronToHuman = (cron: string): string | null => {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [min, hour, dom, month, dow] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (month !== "*") return null;
  if (dom !== "*") {
    if (dow !== "*" || !/^\d+(,\d+)*$/.test(dom)) return null;
    if (!/^\d+$/.test(min) || !/^\d+(,\d+)*$/.test(hour)) return null;
    const times = hour
      .split(",")
      .map((h) => `${pad(Number(h))}:${pad(Number(min))}`);
    return `Every month on the ${listWords(dom.split(",").map(ordinal))} at ${listWords(times)}`;
  }
  if (min === "*" && hour === "*" && dow === "*") return "Every minute";
  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (everyMin && hour === "*" && dow === "*")
    return `Every ${everyMin[1]} minutes`;
  if (min === "0" && hour === "*" && dow === "*") return "Every hour";
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (min === "0" && everyHour && dow === "*")
    return `Every ${everyHour[1]} hours`;
  if (!/^\d+$/.test(min) || !/^\d+(,\d+)*$/.test(hour)) return null;
  const at = `at ${listWords(
    hour.split(",").map((h) => `${pad(Number(h))}:${pad(Number(min))}`),
  )}`;
  if (dow === "*") return `Every day ${at}`;
  if (dow === "1-5") return `Weekdays ${at}`;
  if (dow === "0,6") return `Weekends ${at}`;
  if (!/^[0-7](,[0-7])*$/.test(dow)) return null;
  // Cron reads both 0 and 7 as Sunday.
  const names = [...new Set(dow.split(",").map((d) => Number(d) % 7))].map(
    (d) => DAY_LABELS[d],
  );
  return `Every ${names.join(", ")} ${at}`;
};
