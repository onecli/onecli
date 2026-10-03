/**
 * Calendar-style "when" line for an approval card, from the Start/End strings
 * the gateway lifts off the event body:
 *
 * - Google timed:  `2026-10-01T10:00:00+03:00` / `…Z`
 * - Outlook timed: `2026-10-01T10:00:00 (Pacific Standard Time)`
 * - All-day:       `2026-10-01` (Google's end date is exclusive)
 *
 * Times are shown AS WRITTEN in the request, with its zone, never converted
 * to the viewer's zone: the reviewer checks what the event will say. Anything
 * unrecognized falls back to the raw strings, so nothing is ever hidden.
 */

interface Parsed {
  y: number;
  m: number;
  d: number;
  /** "HH:MM", absent for an all-day date. */
  time?: string;
  /** "UTC", "GMT+3", or an Outlook zone name. */
  zone?: string;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?(?:\s+\((.+)\))?$/;

const zoneFromOffset = (off: string): string => {
  if (off === "Z") return "UTC";
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(off);
  if (!m) return off;
  const [, sign, hh, mm] = m;
  const h = Number(hh);
  if (h === 0 && mm === "00") return "UTC";
  return `GMT${sign}${h}${mm === "00" ? "" : `:${mm}`}`;
};

export const parseEventTime = (raw: string): Parsed | null => {
  const s = raw.trim();
  const d = DATE_RE.exec(s);
  if (d) {
    const [, y = "", m = "", day = ""] = d;
    return { y: +y, m: +m, d: +day };
  }
  const t = DATETIME_RE.exec(s);
  if (!t) return null;
  // Groups: date, time, then the offset (Z / ±HH:MM) or an Outlook zone name.
  const [, y = "", m = "", day = "", hh, mm, offset, zoneName] = t;
  const zone = zoneName ?? (offset ? zoneFromOffset(offset) : undefined);
  return { y: +y, m: +m, d: +day, time: `${hh}:${mm}`, zone };
};

// Formatting the calendar date from its own components (UTC in, UTC out)
// keeps the day exactly as written, whatever the viewer's zone.
const dateFmt = (withYear: boolean) =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });

const utc = (p: Parsed) => new Date(Date.UTC(p.y, p.m - 1, p.d));
const sameDay = (a: Parsed, b: Parsed) =>
  a.y === b.y && a.m === b.m && a.d === b.d;
const dayBefore = (p: Parsed): Parsed => {
  const dt = new Date(utc(p).getTime() - 86_400_000);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
  };
};

export const formatEventWhen = (start?: string, end?: string): string => {
  const raw = [start, end].filter(Boolean).join(" → ");
  const s = start ? parseEventTime(start) : null;
  const e = end ? parseEventTime(end) : null;
  if (!s || (end && !e)) return raw;

  const long = dateFmt(true);
  const short = dateFmt(false);

  // All-day: Google's end date is exclusive, so a one-day event ends "tomorrow".
  if (!s.time) {
    const last = e && !e.time ? dayBefore(e) : null;
    if (!last || !(utc(last) > utc(s))) {
      return `${long.format(utc(s))} · All day`;
    }
    return `${short.format(utc(s))} – ${long.format(utc(last))} · All day`;
  }

  const zone = s.zone ? ` (${s.zone})` : "";
  if (!e || !e.time) return `${long.format(utc(s))} · ${s.time}${zone}`;
  if (sameDay(s, e) && s.zone === e.zone) {
    return `${long.format(utc(s))} · ${s.time} – ${e.time}${zone}`;
  }
  const endZone = e.zone && e.zone !== s.zone ? ` (${e.zone})` : "";
  return `${short.format(utc(s))}, ${s.time}${zone} → ${long.format(utc(e))}, ${e.time}${endZone}`;
};
