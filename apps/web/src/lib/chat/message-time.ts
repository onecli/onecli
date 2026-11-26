/**
 * When a chat message was sent, the way a chat shows it: short for today,
 * more as it gets older. Always in the VIEWER's own time zone and locale
 * (`Intl` with no fixed zone), never the server's or the agent's.
 *
 *   today            5:16 PM
 *   yesterday        Yesterday, 5:16 PM
 *   this year        Nov 7, 5:16 PM
 *   older            Nov 7, 2025, 5:16 PM
 *
 * `now` is a parameter so the boundaries are testable; callers pass the
 * current time.
 */

const TIME = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const DAY_IN_YEAR = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const FULL = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
/** The tooltip: unambiguous, with the weekday and the zone's name. */
const LONG = new Intl.DateTimeFormat(undefined, {
  dateStyle: "full",
  timeStyle: "short",
});

/** Midnight of `date`'s day, in the viewer's zone. */
const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

const DAY_MS = 24 * 60 * 60 * 1000;

export const formatMessageTime = (iso: string, now: Date): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const today = startOfDay(now);
  const day = startOfDay(at);
  if (day === today) return TIME.format(at);
  // DST makes "a day" 23 or 25 hours: compare calendar days, rounded.
  if (Math.round((today - day) / DAY_MS) === 1) {
    return `Yesterday, ${TIME.format(at)}`;
  }
  return at.getFullYear() === now.getFullYear()
    ? DAY_IN_YEAR.format(at)
    : FULL.format(at);
};

/** The full date and time, for the tooltip and screen readers. */
export const formatMessageTimeLong = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : LONG.format(at);
};
